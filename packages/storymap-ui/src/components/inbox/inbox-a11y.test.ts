import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { overlayReserve } from "./useOverlayReserve";

// O CELULAR e o AA do Inbox — o dono decide pelo celular, então o botão principal precisa ser lido
// (contraste AA nos dois temas), tocado (alvos de 44–48 px) e visto (a pílula do feedback não cobre as opções).
// Contraste medido sobre os TOKENS de globals.css (a fórmula do WCAG 2.x), não sobre um palpite.

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const css = read("../../app/globals.css");

/** Os tokens `--nome: R G B;` de um bloco (`:root {` ou `.dark {`). */
function tokens(selector: string): Record<string, [number, number, number]> {
  const start = css.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThan(-1);
  const block = css.slice(start, css.indexOf("\n}", start));
  const out: Record<string, [number, number, number]> = {};
  for (const m of block.matchAll(/--([a-z-]+):\s*(\d+)\s+(\d+)\s+(\d+);/g)) out[m[1]] = [Number(m[2]), Number(m[3]), Number(m[4])];
  return out;
}
const lum = ([r, g, b]: [number, number, number]) => {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const contrast = (a: [number, number, number], b: [number, number, number]) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const light = tokens(":root");
const dark = { ...light, ...tokens(".dark") };

describe("contraste AA nos dois temas", () => {
  it.each([
    ["claro", light],
    ["escuro", dark],
  ])("tema %s: o texto do botão principal, no normal e no hover, passa de 4,5:1", (_t, t) => {
    expect(contrast(t["primary-fg"], t.primary)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t["primary-fg"], t["primary-hover"])).toBeGreaterThanOrEqual(4.5);
  });

  it.each([
    ["claro", light],
    ["escuro", dark],
  ])("tema %s: os links (tinta do âmbar) e o texto do vazio passam de 4,5:1 no papel, na superfície e no poço", (_t, t) => {
    for (const bg of ["canvas", "surface", "inset"]) {
      expect(contrast(t["accent-ink"], t[bg]), `accent-ink/${bg}`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t["fg-muted"], t[bg]), `fg-muted/${bg}`).toBeGreaterThanOrEqual(4.5);
    }
    // o verde como TINTA (o ícone do recibo, «Como fica») sobre o papel
    expect(contrast(t.primary, t.surface)).toBeGreaterThanOrEqual(4.5);
  });

  it("as superfícies do Inbox não pintam TEXTO com o âmbar cru (2,2:1 no papel) — só com a tinta dele", () => {
    const files = [
      ...readdirSync(fileURLToPath(new URL(".", import.meta.url))).filter((f) => f.endsWith(".tsx")).map((f) => `./${f}`),
      "../BoardHeader.tsx",
      "../inicio/InboxPanel.tsx",
      "../inicio/InboxItemScreen.tsx",
    ];
    // a classe crua (entre aspas/espaços), não a menção num comentário
    for (const f of files) expect(read(f), f).not.toMatch(/(?<=["' ])text-accent(?=["' ])/);
    expect(read("../nav/NavShell.tsx").slice(read("../nav/NavShell.tsx").indexOf("export function NavPopoverFooter("))).toMatch(/text-accent-ink/);
  });

  it("a contagem da aba do celular é legível: a tinta escura do dono sobre o âmbar do dono, não branco sobre âmbar", () => {
    // O âmbar da aba é o MESMO token do chip do desktop e da pílula do card (`--state-owner`), cuja
    // legibilidade nos dois temas é medida em lib/storymap/presence-tone.test.ts. Era `amber-400`/`amber-950` cru.
    const header = read("../BoardHeader.tsx");
    const tab = header.slice(header.indexOf("function MobileInboxTab("), header.indexOf("function MobileInboxTab(") + 1400);
    expect(tab).toMatch(/bg-state-owner[^"]*text-state-owner-fg/);
    expect(tab).not.toMatch(/text-white/);
  });
});

describe("alvos de toque de 44–48 px", () => {
  const dir = fileURLToPath(new URL(".", import.meta.url));
  const sources = readdirSync(dir)
    .filter((f) => f.endsWith(".tsx"))
    .map((f) => [f, read(`./${f}`)] as const);

  it("todo <summary> e todo botão de classe fixa nas superfícies do Inbox tem 44 px ou mais", () => {
    const small: string[] = [];
    for (const [f, src] of [...sources, ["SystemDriftPanel.tsx", read("../SystemDriftPanel.tsx")] as const]) {
      for (const m of src.matchAll(/<(summary|button)\b[^>]*?className="([^"]*)"/g)) {
        // o fundo clicável da folha (fecha ao tocar fora) é a tela inteira, não um alvo pequeno
        if (/\babsolute inset-0\b/.test(m[2])) continue;
        if (!/\b(min-h-1[1-4]|h-1[1-4])\b/.test(m[2])) small.push(`${f}: <${m[1]} class="${m[2].slice(0, 70)}">`);
      }
    }
    expect(small).toEqual([]);
  });

  it("as opções do item têm 48 px; a página do item ausente leva a um alvo de 44 px", () => {
    expect(read("./InboxItemCard.tsx")).toMatch(/min-h-12 w-full items-center justify-center/);
    expect(read("../inicio/InboxItemScreen.tsx")).toMatch(/href=\{missing\.href\}[^>]*min-h-11/);
  });
});

describe("a pílula do feedback não cobre as opções", () => {
  it("a barra de decisão reserva o espaço da pílula enquanto passa por baixo dela", () => {
    // celular: a barra ocupa a largura toda, 180 px acima do fim da tela → a pílula sobe 180 px
    expect(overlayReserve({ top: 664, bottom: 844, left: 0 }, 844)).toBe(180);
    // desktop: a coluna começa à direita da pílula → nada a reservar
    expect(overlayReserve({ top: 700, bottom: 900, left: 336 }, 900)).toBeNull();
    // fora da tela → nada
    expect(overlayReserve({ top: 900, bottom: 1080, left: 0 }, 844)).toBeNull();
  });

  it("o cartão aberto liga a reserva na barra presa embaixo, e a reserva sai quando o item fecha", () => {
    const card = read("./InboxItemCard.tsx");
    expect(card).toMatch(/useOverlayReserve\(barRef\)/);
    expect(card).toMatch(/<div ref=\{barRef\} className=\{cn\(sticky/);
    const hook = read("./useOverlayReserve.ts");
    expect(hook).toMatch(/setProperty\("--ah-bottom-reserve"/);
    expect(hook).toMatch(/return \(\) => \{[\s\S]*removeProperty\("--ah-bottom-reserve"\)/);
    // o overlay lê a MESMA variável (o contrato do host)
    expect(read("../../../public/ah-overlay.js")).toContain("var(--ah-bottom-reserve, 0px)");
  });

  it("a folha aberta deixa o fundo `inert` (o leitor de tela e o Tab não saem dela)", () => {
    expect(read("./InboxSheet.tsx")).toMatch(/setAttribute\("inert", ""\)/);
  });
});
