import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SHORT_DESKTOP_MEDIA } from "@/lib/viewport";

// A GEOMETRIA do trecho do fluxo (as variáveis `--flow-*` de `.ah-flow` em globals.css) nos dois tamanhos: o de sempre
// (computador alto e celular, 150px — os números do protótipo) e o compacto do computador baixo (~100px). O rig é node
// sem DOM: a prova é aritmética sobre os valores declarados — os três níveis de caixinha cabem no poço, a legenda cabe
// entre o poço e a borda — e o FlowBand só posiciona pelas variáveis (nenhum px cravado sobrou para divergir).

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const css = read("../../app/globals.css");
const band = read("./FlowBand.tsx");
const lane = read("./KanbanLane.tsx");

function vars(block: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of block.matchAll(/--flow-([a-z-]+):\s*(\d+)px;/g)) out[m[1]] = Number(m[2]);
  return out;
}

const tallBlock = /\.ah-flow \{([^}]*)\}/.exec(css)?.[1] ?? "";
const shortMedia = css.indexOf(`@media ${SHORT_DESKTOP_MEDIA} {\n  .ah-flow {`);
const shortBlock = shortMedia >= 0 ? (/\.ah-flow \{([^}]*)\}/.exec(css.slice(shortMedia))?.[1] ?? "") : "";
const TALL = vars(tallBlock);
const SHORT = vars(shortBlock);

const LEVELS = 3; // o encaixe empilha até 3 caixinhas (kanban-features `p5place`)
const CAPTION_LINE = 16;

function fits(g: Record<string, number>, captionLines: number) {
  const wellBottom = g["well-top"] + g["well-h"];
  const lowestCrateBottom = g.h - g.floor; // y do pé da caixinha do nível 0
  const highestCrateTop = g.h - (g.floor + (LEVELS - 1) * g.level) - g.crate;
  return {
    cratesInWell: highestCrateTop >= g["well-top"] && lowestCrateBottom <= wellBottom,
    captionBelowWell: g["caption-top"] >= wellBottom && g["live-caption-top"] >= wellBottom,
    captionInBand: g["caption-top"] + captionLines * CAPTION_LINE <= g.h && g["live-caption-top"] + CAPTION_LINE <= g.h,
    labelAboveWell: g["label-top"] + 16 <= g["well-top"],
    beltInWell: g["belt-top"] >= lowestCrateBottom && g["belt-top"] + 2 <= wellBottom,
    pileInWell: g.h - g.floor - (3 * g.pile + 2 * g["pile-gap"]) >= g["well-top"],
  };
}

describe("o trecho do fluxo — a geometria", () => {
  it("o computador alto e o celular mantêm os números do protótipo (150px)", () => {
    expect(TALL).toMatchObject({ h: 150, "label-top": 12, "well-top": 38, "well-h": 72, crate: 16, floor: 48, level: 20, pile: 12 });
  });
  it("o computador baixo compacta para ~100px com a MESMA estrutura (caixinhas e pilha menores), na query de lib/viewport", () => {
    expect(shortMedia).toBeGreaterThan(0);
    expect(SHORT.h).toBeLessThanOrEqual(100);
    expect(SHORT.crate).toBeLessThan(TALL.crate);
    expect(SHORT.pile).toBeLessThan(TALL.pile);
    // as mesmas variáveis nos dois tamanhos — nenhuma esquecida no compacto
    expect(Object.keys(SHORT).sort()).toEqual(Object.keys(TALL).sort());
  });
  it("nos dois tamanhos os 3 níveis cabem no poço, a esteira e a pilha também, e a legenda cabe entre o poço e a borda", () => {
    const all = { cratesInWell: true, captionBelowWell: true, captionInBand: true, labelAboveWell: true, beltInWell: true, pileInWell: true };
    expect(fits(TALL, 2)).toEqual(all);
    expect(fits(SHORT, 1)).toEqual(all);
  });
  it("o FlowBand posiciona só pelas variáveis: nada de 150/48/20/16px cravado, e a legenda vira UMA linha no baixo", () => {
    expect(band).toContain('"ah-flow relative h-[var(--flow-h)]');
    expect(band).not.toMatch(/h-\[150px\]|top-\[(38|44|104|115|120|140)px\]|bottom-\[48px\]|const FLOOR|const LEVEL/);
    expect(band).toContain("const crateBottom = (lvl: number) => `calc(var(--flow-floor) + ${lvl} * var(--flow-level))`;");
    // duas linhas de 16px no alto, UMA no baixo — a quebra é entre as frases (DotList), nunca um «·» sobrando no fim
    expect(band).toMatch(/top-\[var\(--flow-caption-top\)\] leading-4/);
    expect(band).toMatch(/<DotList className="max-h-8 overflow-hidden short:max-h-4"/);
    expect(band).toMatch(/<DotList aria-hidden="true" className="hidden max-h-4 overflow-hidden short:block"/);
    // o «·» de cada frase mora no recuo dela, e a lista começa um recuo antes da borda (a caixa corta o do começo da linha)
    expect(band).toMatch(/<span className="-ml-\[14px\] flex flex-wrap items-baseline">/);
    // o «·» fica NA LINHA do texto (inline no recuo), não `absolute top-0`: ao lado de um botão com folga de toque, subia
    expect(band).toMatch(/<span key=\{i\} className="min-w-0 pl-\[14px\]">[\s\S]{0,160}<span aria-hidden className="-ml-\[14px\] inline-block w-\[14px\]/);
    expect(band).not.toMatch(/absolute left-0 top-0 w-\[14px\]/);
    // o popover da caixinha acompanha o tamanho do trecho
    expect(band).toMatch(/const top = `max\(6px, calc\(var\(--flow-h\) - \$\{crateBottom\(c\.lvl\)\} - var\(--flow-crate\) - 6px\)\)`;/);
  });
});

describe("a raia reserva o compositor", () => {
  it("no computador baixo o fundo da raia é EXATAMENTE a altura publicada do compositor; no alto e no celular, a folga de sempre", () => {
    expect(lane).toContain('export const LANE_BOTTOM_RESERVE = "tall:pb-[220px] short:pb-[var(--jido-composer-h,0px)]";');
    expect(lane).toMatch(/p-3 pb-44 md:min-h-0 md:overflow-y-auto \$\{LANE_BOTTOM_RESERVE\}/);
    expect(lane).not.toContain("md:pb-[220px]");
  });
});
