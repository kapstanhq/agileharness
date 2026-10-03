// A TRAVA entre o que o `<head>` PROMETE e o que existe em `public/splash/`.
//
// O iOS não avisa quando um `apple-touch-startup-image` aponta para o vazio: ele simplesmente abre o
// PWA numa tela chapada. Ou seja, o defeito só aparece para quem instalou o app no aparelho exato que
// ficou de fora — a categoria de bug que ninguém encontra e todo mundo vê. Este teste fecha isso: a
// lista de aparelhos (`APPLE_SPLASH`, a mesma que o `scripts/gen-splash.ts` consome) tem de ter um
// PNG commitado, com as dimensões que o `<link>` declara.
//
// Ele NÃO confere o DESENHO — isso exigiria navegador e um build (ver o cabeçalho de `gen-splash.ts`).
// Confere o que dá para conferir de graça: existência, tamanho e coerência da lista.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { APPLE_SPLASH, splashHref, splashMedia } from "./pwa-splash";

const PUBLIC = join(new URL("../..", import.meta.url).pathname, "public");

/** Largura e altura de um PNG, lidas do IHDR (os 8 bytes logo depois da assinatura + "IHDR"). */
function pngSize(file: string): { w: number; h: number } {
  const buf = readFileSync(file);
  expect([...buf.subarray(0, 4)], `${file}: sem assinatura PNG`).toEqual([0x89, 0x50, 0x4e, 0x47]);
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

describe("splash do PWA — o que o <head> promete existe em public/", () => {
  it("todo aparelho declarado tem o PNG, no tamanho exato em DEVICE pixels", () => {
    for (const d of APPLE_SPLASH) {
      const file = join(PUBLIC, splashHref(d));
      expect(existsSync(file), `${splashHref(d)} não existe — rode \`bun run build && bun run gen-splash\``).toBe(
        true,
      );
      expect(pngSize(file), `${splashHref(d)}: dimensões`).toEqual({ w: d.w, h: d.h });
    }
  });

  it("a lista não tem aparelho repetido nem media query ambígua", () => {
    // Dois aparelhos com o mesmo (css × densidade) fariam o iOS escolher um dos dois ao acaso.
    const chaves = APPLE_SPLASH.map((d) => `${d.cw}x${d.ch}@${d.r}`);
    expect(new Set(chaves).size, `media query duplicada em: ${chaves.join(", ")}`).toBe(chaves.length);
    const arquivos = APPLE_SPLASH.map(splashHref);
    expect(new Set(arquivos).size, "arquivo repetido").toBe(arquivos.length);
  });

  it("os device pixels são os px CSS vezes a densidade — o par que o iOS casa", () => {
    // Um `w`/`h` que não bate com `cw × r` é o erro de digitação que gera um PNG do tamanho errado:
    // o `<link>` casa o aparelho, o iOS estica a imagem e o mascote sai borrado.
    for (const d of APPLE_SPLASH) {
      expect([d.w, d.h], `${d.cw}×${d.ch}@${d.r}× deveria dar ${d.cw * d.r}×${d.ch * d.r}`).toEqual([
        d.cw * d.r,
        d.ch * d.r,
      ]);
    }
  });

  it("a media query nomeia largura, altura, densidade e retrato", () => {
    const q = splashMedia(APPLE_SPLASH[0]);
    expect(q).toContain(`(device-width: ${APPLE_SPLASH[0].cw}px)`);
    expect(q).toContain(`(device-height: ${APPLE_SPLASH[0].ch}px)`);
    expect(q).toContain(`(-webkit-device-pixel-ratio: ${APPLE_SPLASH[0].r})`);
    expect(q).toContain("(orientation: portrait)");
  });
});
