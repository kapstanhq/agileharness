#!/usr/bin/env bun
// GERA as telas de abertura do PWA no iOS (`public/splash/apple-splash-*.png`) — mascote + lockup
// sobre #191919, a composição do card 5g da prancha do design.
//
// POR QUE ELE EXISTE: esses 13 PNGs foram assados à mão uma vez (c48753be9) e **nunca tiveram
// produtor**. Quando a anatomia do Jido foi corrigida para a grade do design, o app, a aba e o
// launcher passaram a mostrar o bicho certo — e a tela de abertura continuou com o antigo. É a mesma
// deriva silenciosa que o `gen-icons.ts` existe para impedir, na única superfície que ainda não
// tinha dono.
//
// POR QUE ELE USA UM NAVEGADOR, e o `gen-icons.ts` não: o lockup tem o "Agile" MANUSCRITO (Playpen
// Sans). Um encoder de PNG escrito à mão desenha retângulo, não glifo — rasterizar uma fonte exigiria
// um motor de fonte inteiro. O Chrome já está na máquina e já sabe fazer isso; o que ele desenha é o
// MESMO SVG e a MESMA tabela de pixels que o React usa (`mascot.ts` + `HARNESS_PIXELS`), então não
// existe segunda verdade — só um rasterizador diferente.
//
// PRÉ-REQUISITO: um `bun run build` recente. A fonte é self-hosted pelo `next/font/google` durante o
// build, e é de lá (`.next/static/*`) que este script a lê — nada de baixar de rede a cada geração.
//
// POR QUE ELE **NÃO** ENTRA NO TESTE DE DERIVA (ao contrário dos ícones): o `mascot-icons.test.ts`
// compara bytes com o que o gerador produz na hora, e isso só funciona porque aquele gerador é
// aritmética pura. Este aqui precisa de navegador e de um build — pendurar a suíte nos dois faria
// `bun test` depender de Chrome, o que é caro e frágil. O que trava a deriva aqui é o processo:
// mexeu na arte → `bun run gen-icons && bun run build && bun run gen-splash`.
//
// Uso: `bun run gen-splash` (de packages/storymap-ui).

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HARNESS_PIXELS } from "../src/components/AgileHarnessLogo";
import { ARMS, BODY, RESTING, silhouettePath } from "../src/lib/storymap/copilot/mascot";
import { APPLE_SPLASH } from "../src/lib/pwa-splash";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(PKG, "public", "splash");
const NEXT = join(PKG, ".next");

/** #191919 — o mesmo fundo do ícone e o `background_color` do manifest. */
const BG = "#191919";
/** #F5F3EE — a tinta do card 5g. No splash o desenho é GRANDE: branco puro ali vira flash na cara de
 *  quem abriu o app no escuro; no ícone de 16px, ao contrário, ele é o que dá contraste. */
const INK = "#F5F3EE";
/** O laranja aviação da marca — só o ponto de junção do lockup. */
const ORANGE = "#FF4F00";


/** A caixa que o desenho ocupa na grade — a mesma medida que enquadra os ícones. */
function drawingBox() {
  const rects = [...BODY, ...ARMS[RESTING.arms]];
  const x = Math.min(...rects.map((r) => r[0]));
  const y = Math.min(...rects.map((r) => r[1]));
  return {
    x,
    y,
    w: Math.max(...rects.map((r) => r[0] + r[2])) - x,
    h: Math.max(...rects.map((r) => r[1] + r[3])) - y,
  };
}

/**
 * A FONTE, tirada do build. O `next/font/google` baixa os woff2 no build e emite os `@font-face` no
 * CSS com um nome de família gerado (`__Playpen_Sans_xxxxxx`). Trocamos a URL pública de cada um por
 * um caminho de arquivo, que é o que o Chrome consegue abrir sem servidor nenhum.
 *
 * ⚠️ São DEZENAS de regras para a mesma família — uma por SUBCONJUNTO Unicode (`unicode-range`):
 * latim, latim estendido, cirílico, e um punhado só de emoji. Pegar "a primeira que fala Playpen"
 * é a armadilha: a primeira do arquivo é a de emoji, que não tem letra nenhuma, e o "Agile" sai no
 * fallback serifado — foi exatamente o que aconteceu na primeira geração. Levamos TODAS: é o
 * navegador que escolhe a fatia certa por caractere, e é esse o trabalho dele.
 */
export function playpenFaces(): { css: string; family: string } {
  const cssDir = join(NEXT, "static", "css");
  if (!existsSync(cssDir)) throw new Error(`sem build: ${cssDir} não existe — rode \`bun run build\` antes`);
  const regras: string[] = [];
  let family = "";
  for (const file of readdirSync(cssDir).filter((f) => f.endsWith(".css"))) {
    for (const face of (readFileSync(join(cssDir, file), "utf8").match(/@font-face\s*{[^}]*}/g) ?? [])) {
      if (!/Playpen/i.test(face)) continue;
      const fam = face.match(/font-family:\s*['"]?([^;'"]+)['"]?\s*;/)?.[1]?.trim();
      const url = face.match(/url\(([^)]+)\)/)?.[1]?.replace(/['"]/g, "");
      if (!fam || !url) continue;
      const local = join(NEXT, url.replace(/^\/_next\//, ""));
      if (!existsSync(local)) continue;
      family ||= fam;
      regras.push(face.replace(/url\([^)]+\)/, `url("file://${local}")`));
    }
  }
  if (!regras.length) {
    throw new Error("não achei nenhum @font-face da Playpen Sans no CSS do build — o lockup sairia sem o 'Agile'");
  }
  return { css: regras.join("\n"), family };
}

/** A página de UM aparelho, em px CSS. O Chrome cuida do device pixel ratio. */
export function splashHtml(cw: number, ch: number, font: { css: string; family: string }): string {
  const box = drawingBox();
  // O mascote pela MENOR das duas medidas: ancorar só na largura o inflaria num tablet, e só na
  // altura o encolheria num celular estreito. As frações saem do card 5g (o desenho ocupa ~28% da
  // largura do painel e ~23% da altura).
  const mascotW = Math.round(Math.min(cw * 0.28, ch * 0.16));
  const mascotH = Math.round((mascotW * box.h) / box.w);
  const logo = Math.max(10, Math.round(mascotW / 5.8)); // altura ótica do HARNESS
  const agile = Math.round(logo * 1.45);
  const dot = Math.round(logo / 4);
  const gap = Math.round(mascotW * 0.25); // 5g: 26px de respiro para um mascote de 104

  // A viewBox é a CAIXA DO DESENHO, não a grade — é ela que corta a margem morta e faz `mascotW`
  // significar "a largura do bicho". (Enquadrar pela grade de 50 e depois corrigir com um `scale` no
  // `<g>` escala DUAS vezes: a viewBox já mapeia unidade→pixel, e o transform multiplica de novo.)
  return `<!doctype html><html><head><meta charset="utf-8"><style>
${font.css}
html,body{margin:0;padding:0;width:100%;height:100%;background:${BG};overflow:hidden}
.wrap{width:100vw;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:${gap}px}
.lock{display:inline-flex;align-items:flex-end;gap:${logo >= 16 ? 3 : 2}px;line-height:1;color:${INK}}
.agile{font-family:'${font.family}','Playpen Sans',cursive;font-weight:500;font-size:${agile}px;line-height:.72;letter-spacing:-.09em}
.dot{width:${dot}px;height:${dot}px;background:${ORANGE};flex:none;margin-bottom:${Math.round(logo / 3)}px}
svg{display:block;flex:none}
</style></head><body><div class="wrap">
<svg width="${mascotW}" height="${mascotH}" viewBox="${box.x} ${box.y} ${box.w} ${box.h}">
  <path d="${silhouettePath(RESTING)}" fill="${INK}"/>
</svg>
<span class="lock"><span class="agile">Agile</span><span class="dot"></span>
<svg width="${logo * 6.8}" height="${logo}" viewBox="0 0 68 10"><g fill="currentColor">${HARNESS_PIXELS.map(
    ([x, y, w, h]) => `<rect x="${x}" y="${y}" width="${w}" height="${h}"/>`,
  ).join("")}</g></svg></span>
</div></body></html>`;
}

// ── main ────────────────────────────────────────────────────────────────────
// Só escreve quando RODADO como script (o teste de contrato importa `splashHtml`, sem gerar nada).

if (process.argv[1]?.includes("gen-splash")) {
  const font = playpenFaces();
  const work = mkdtempSync(join(tmpdir(), "ah-splash-"));
  try {
    for (const d of APPLE_SPLASH) {
      const page = join(work, `p-${d.w}x${d.h}.html`);
      writeFileSync(page, splashHtml(d.cw, d.ch, font));
      const out = join(OUT, `apple-splash-${d.w}x${d.h}.png`);
      execFileSync(
        "google-chrome",
        [
          "--headless",
          "--disable-gpu",
          "--no-sandbox",
          "--hide-scrollbars",
          `--force-device-scale-factor=${d.r}`,
          `--window-size=${d.cw},${d.ch}`,
          `--screenshot=${out}`,
          page,
        ],
        { stdio: "pipe" },
      );
      console.log(`  apple-splash-${d.w}x${d.h}.png`.padEnd(34), `${d.cw}×${d.ch} css @${d.r}×`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
