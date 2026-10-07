import postcss from "postcss";
import tailwindcss from "tailwindcss";
import { describe, expect, it } from "vitest";
import twConfig from "../../tailwind.config";
import { COMPACT_COMPOSER_QUERY, SHORT_DESKTOP_MEDIA, TALL_DESKTOP_MEDIA, TALL_MIN_HEIGHT, VIEWPORT_VARIANTS } from "./viewport";

// As faixas de tela pela ALTURA (lib/viewport.ts). Duas garantias: as três faixas PARTICIONAM toda tela (nenhum tamanho
// fica sem desenho, nenhum recebe dois), e o Tailwind de fato gera as variantes `tall:`/`short:` com essas queries.

/** Avalia a gramática que estas queries usam: `(min|max-width|height: Npx)` com `and`, e `,` como OU. */
function matches(query: string, w: number, h: number): boolean {
  return query.split(",").some((alt) =>
    alt
      .split(" and ")
      .map((c) => c.trim())
      .every((c) => {
        const m = /^\((min|max)-(width|height): (\d+)px\)$/.exec(c);
        if (!m) throw new Error(`condição fora da gramática: ${c}`);
        const v = m[2] === "width" ? w : h;
        return m[1] === "min" ? v >= Number(m[3]) : v <= Number(m[3]);
      }),
  );
}

const SIZES: [number, number][] = [
  [390, 844], // celular em pé
  [844, 390], // celular deitado
  [1366, 600], // o notebook do dono (altura útil)
  [1366, 768],
  [1280, 799],
  [1280, 800],
  [1366, 1000],
  [1920, 1080],
  [767, 600],
  [768, 600],
  [768, 1024],
];

describe("as faixas de tela", () => {
  it("celular, computador baixo e computador alto particionam todo tamanho", () => {
    for (const [w, h] of SIZES) {
      const mobile = w < 768;
      const hits = [mobile, matches(SHORT_DESKTOP_MEDIA, w, h), matches(TALL_DESKTOP_MEDIA, w, h)].filter(Boolean);
      expect(hits, `${w}x${h}`).toHaveLength(1);
    }
  });
  it("o notebook de 1366×600 é BAIXO; 1366×1000 é ALTO; o celular de 390×844 não é nenhum dos dois", () => {
    expect(matches(SHORT_DESKTOP_MEDIA, 1366, 600)).toBe(true);
    expect(matches(TALL_DESKTOP_MEDIA, 1366, 1000)).toBe(true);
    expect(matches(SHORT_DESKTOP_MEDIA, 390, 844) || matches(TALL_DESKTOP_MEDIA, 390, 844)).toBe(false);
    expect(TALL_MIN_HEIGHT).toBe(800);
  });
  it("o compositor é compacto exatamente onde o desenho inteiro NÃO vale (celular + computador baixo)", () => {
    for (const [w, h] of SIZES) expect(matches(COMPACT_COMPOSER_QUERY, w, h), `${w}x${h}`).toBe(!matches(TALL_DESKTOP_MEDIA, w, h));
  });
});

describe("as variantes do Tailwind", () => {
  it("`tall:` e `short:` saem com as queries de lib/viewport.ts — e os `max-md:` continuam existindo", async () => {
    expect(VIEWPORT_VARIANTS).toEqual({ tall: TALL_DESKTOP_MEDIA, short: SHORT_DESKTOP_MEDIA });
    const { css } = await postcss([
      tailwindcss({ ...twConfig, content: [{ raw: '<i class="tall:pt-14 short:pb-[var(--jido-composer-h,0px)] max-md:h-10"></i>', extension: "html" }] }),
    ]).process("@tailwind utilities;", { from: undefined });
    expect(css).toContain(`@media ${TALL_DESKTOP_MEDIA}`);
    expect(css).toContain(`@media ${SHORT_DESKTOP_MEDIA}`);
    expect(css).toMatch(/\.tall\\:pt-14\s*\{\s*padding-top: 3\.5rem/);
    expect(css).toMatch(/padding-bottom: var\(--jido-composer-h,0px\)/);
    expect(css).toMatch(/\.max-md\\:h-10/);
  });
});
