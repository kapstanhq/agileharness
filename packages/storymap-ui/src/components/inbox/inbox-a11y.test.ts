import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// O CELULAR e o AA do Inbox — o dono decide pelo celular, então o botão principal precisa ser lido
// (contraste AA nos dois temas), tocado (alvos de 44–48 px) e visto (nada preso por cima das opções).
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
      // a barra do topo: o ícone do Inbox e o seu painel (a home do Início saiu; a página do item mora em ./)
      "../shell/InboxIconLink.tsx",
    ];
    // a classe crua (entre aspas/espaços), não a menção num comentário
    for (const f of files) expect(read(f), f).not.toMatch(/(?<=["' ])text-accent(?=["' ])/);
    expect(read("../nav/NavShell.tsx").slice(read("../nav/NavShell.tsx").indexOf("export function NavPopoverFooter("))).toMatch(/text-accent-ink/);
  });

  it("a contagem do Inbox na barra é legível: TINTA (`text-fg`) sobre a superfície, nunca branco nem o âmbar cru", () => {
    // A aba do celular (âmbar do dono preenchido) saiu com a navegação inferior (fase 1). O número que ficou é o do
    // ícone da barra, em tinta — 12,26:1 no claro (medido em globals.css); o âmbar ficou só para o ESTADO do card.
    const link = read("../shell/InboxIconLink.tsx");
    expect(link).toMatch(/<b className="[^"]*\btext-fg\b[^"]*">\{total == null \? "" : total\}<\/b>/);
    expect(link).not.toMatch(/text-white/);
    expect(read("../BoardHeader.tsx")).not.toMatch(/function MobileInboxTab\(/);
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

  it("as opções do item têm 44 px e quebram linha (nada de rolagem de lado); a página do item ausente leva a um alvo de 44 px", () => {
    const options = read("./InboxOptions.tsx");
    expect(options).toMatch(/const BTN =\s*"inline-flex min-h-11 max-w-full /);
    expect(options).toMatch(/<div className="flex flex-wrap gap-2">/);
    expect(read("./InboxItemScreen.tsx")).toMatch(/href=\{missing\.href\}[^>]*min-h-11/);
  });

  // Visto no ar (v0.11.0, 390px): as faixas («Ative o aviso no celular…», «A ferramenta não está bem…») punham os
  // botões AO LADO da frase, e o `flex-1` sem piso espremia a frase até uma palavra por linha. O contrato: a frase das
  // faixas e avisos do Inbox tem PISO de largura numa linha que QUEBRA, e os botões andam juntos — no celular eles
  // descem para baixo da frase, que fica com a largura inteira.
  it("as faixas e os avisos do Inbox quebram as ações para BAIXO da frase no celular (a frase nunca é espremida)", () => {
    const item = read("./InboxItem.tsx");
    const banner = item.slice(item.indexOf('if (variant === "banner")'), item.indexOf('if (variant === "short")'));
    expect(banner).toMatch(/data-host-notice=\{entry\.kind\}[^>]*className="flex flex-wrap /);
    expect(banner).toMatch(/<p className="min-w-\[min\(100%,18rem\)\] flex-1 /);
    // os botões num grupo só (descem juntos), cada um com 44 px
    expect(banner).toMatch(/<div className="flex flex-wrap items-center gap-2" data-host-notice-actions>\s*\{shown\.map/);
    expect(banner).toMatch(/"inline-flex min-h-11 items-center rounded-\[10px\]/);
    const stale = read("./StaleArchive.tsx");
    expect(stale).toMatch(/className="flex flex-wrap [^"]*" data-stale-archive>\s*<span className="min-w-\[min\(100%,18rem\)\] flex-1 /);
    const caring = read("./AgentsCaring.tsx");
    expect(caring).toMatch(/aria-controls="inbox-cuidando-body"[\s\S]{0,120}className="flex min-h-12 w-full flex-wrap /);
    expect(caring).toMatch(/id="inbox-cuidando" className="min-w-\[min\(calc\(100%_-_1\.5rem\),14rem\)\] flex-1 /);
    // e nenhuma frase de faixa volta ao `min-w-0 flex-1` sem piso (a forma que espremia)
    for (const src of [banner, stale, caring]) expect(src).not.toMatch(/<(p|span)[^>]*className="min-w-0 flex-1/);
  });
});

// A barra de decisão PRESA embaixo (a folha e a página do item) e a reserva da pílula do feedback saíram com ela na
// fase 3: as opções moram no próprio item, na lista. O que prova que nada cobre as opções agora é a AUSÊNCIA de peça
// presa e a reserva do rodapé do compositor nas duas páginas (o último item rola para cima dele).
describe("nada preso por cima das opções", () => {
  it("o item não tem barra presa nem folha modal; as páginas reservam o rodapé do compositor", () => {
    const item = read("./InboxItem.tsx");
    expect(item).not.toMatch(/\bsticky\b|aboveComposer|useOverlayReserve/);
    expect(item).not.toMatch(/aria-modal/);
    expect(read("../CockpitView.tsx")).toMatch(/\$\{composerGutter\}/);
    expect(read("./InboxItemScreen.tsx")).toMatch(/\$\{composerGutter\}/);
  });

  it("o foco é visível no item (a lista leva o foco ao próximo depois do clique) e nas opções", () => {
    expect(read("./InboxItem.tsx")).toMatch(/tabIndex=\{-1\}[\s\S]{0,200}focus-visible:ring-2/);
    expect(read("./InboxOptions.tsx")).toMatch(/focus-visible:ring-2 focus-visible:ring-accent/);
  });

  it("a seta da linha recolhida respeita `prefers-reduced-motion`", () => {
    expect(read("./AgentsCaring.tsx")).toMatch(/motion-reduce:transition-none/);
  });
});
