import { fileURLToPath } from "node:url";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// CONTRATO das superfícies de DOCUMENTO, asserido sobre a FONTE (o rig deste pacote é node-env, sem
// renderizador de DOM — mesmo padrão de QuickActionButton.contract.test.ts e kanban-card-footer.test.ts).
//
// Cada item aqui é uma decisão de UX que a validação visual MEDIU e que uma edição distraída desfaz sem
// quebrar teste nenhum. É esse o buraco que estes contratos tapam: `tsc` e a suíte não enxergam 24px de
// folga a menos, e a próxima pessoa a mexer no shell não tem como saber que o número importava.

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const shell = read("./DocShell.tsx");
const table = read("./views/TableView.tsx");
const board = read("./views/BoardView.tsx");

describe("DocShell — folga do rodapé no celular", () => {
  // MEDIDO: a nav inferior é `fixed` e `md:hidden` (BoardHeader), 57px de altura num viewport de 844.
  // O `py-8` original reservava 32px — o fim do documento passava POR BAIXO dela e ficava inalcançável.
  it("reserva pb-24 no celular e volta a pb-8 a partir de md (o degrau das telas irmãs)", () => {
    expect(shell).toContain('const BOTTOM_GUTTER = "pb-24 md:pb-8"');
  });

  it("as DUAS colunas de leitura (com e sem sumário) usam a mesma folga", () => {
    const usos = shell.match(/BOTTOM_GUTTER/g) ?? [];
    // 1 declaração + 2 usos: o ramo `outline` e o ramo simples. Um só = alguém corrigiu metade.
    expect(usos.length, "BOTTOM_GUTTER precisa valer nos dois ramos de layout").toBe(3);
  });

  it("nenhum ramo voltou ao py-8 simétrico", () => {
    expect(shell).not.toMatch(/px-4 py-8 sm:px-8/);
  });
});

describe("DocShell — o alternador de views cabe numa linha no celular", () => {
  // MEDIDO: com os quatro rótulos visíveis o alternador media 367px num viewport de 375 — tomava a linha
  // inteira e empurrava o menu "…" para uma TERCEIRA linha, vazia à direita.
  it("só a view ATIVA mostra o rótulo abaixo de sm", () => {
    expect(shell).toContain('isActive ? "inline" : "hidden sm:inline"');
  });

  it("a view sem rótulo visível continua anunciada para leitor de tela", () => {
    expect(shell).toMatch(/aria-label=\{v\.label\}/);
    expect(shell).toMatch(/title=\{v\.label\}/);
  });

  it("a barra INLINE reserva a própria folga abaixo de si", () => {
    // MEDIDO no navegador: 0px de folga visível nas três views (documento, quadro, tabela). O título
    // do documento tem `mb-8` e nenhuma margem no topo; o quadro e a tabela começam na borda. A folga
    // pertence à BARRA — deixá-la a cargo de cada view faz a próxima nascer colada de novo.
    expect(shell).toContain('inline ? "mb-6 justify-end" : "shrink-0"');
  });

  it("EDITAR é botão do cluster, não item do menu '…'", () => {
    // A regressão que este teste impede é o caminho de volta: "Editar texto" morava dentro do overflow,
    // e o gesto mais óbvio de uma página de conteúdo ficava atrás de três pontinhos.
    expect(shell).not.toContain("Editar texto");
    expect(shell).toMatch(/onModeChange\(mode === "edit" \? "read" : "edit"\)/);
  });
});

describe("TableView — coluna sem dado não se desenha", () => {
  it("grupo e etiqueta são condicionais ao conteúdo real das linhas", () => {
    expect(table).toContain("const hasGroups = rows.some((r) => !!r.group)");
    expect(table).toContain("const hasTags = rows.some((r) => r.tags.length > 0)");
    // cabeçalho E célula — esconder só um dos dois desalinha a grade inteira.
    expect(table).toContain("{hasGroups && <Th>Grupo</Th>}");
    expect(table).toContain("{hasTags && <Th>Etiqueta</Th>}");
    expect((table.match(/\{hasGroups && \(/g) ?? []).length).toBe(1);
    expect((table.match(/\{hasTags && \(/g) ?? []).length).toBe(1);
  });

  it("a grade rola dentro do próprio contêiner — a página nunca rola de lado", () => {
    expect(table).toContain('cn("overflow-x-auto"');
  });
});

describe("Tokens — a rampa de tinta passa o piso AA", () => {
  // Os hex vivem em globals.css e uma edição bem-intencionada ("clareia um pouco esse cinza") desfaz
  // a correção sem quebrar nada. Aqui o número é RECALCULADO a partir do arquivo, não copiado: se
  // alguém mexer no token, a conta reprova.
  const css = readFileSync(fileURLToPath(new URL("../../app/globals.css", import.meta.url)), "utf8");

  const rgbOf = (token: string, ocorrencia: number) => {
    const todas = [...css.matchAll(new RegExp(`--${token}:\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)`, "g"))];
    const m = todas[ocorrencia];
    if (!m) throw new Error(`token --${token} (ocorrência ${ocorrencia}) não encontrado`);
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  const lum = (c: number[]) => {
    const s = c.map((v) => {
      const x = v / 255;
      return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * s[0] + 0.7152 * s[1] + 0.0722 * s[2];
  };
  const ratio = (a: number[], b: number[]) => {
    const [hi, lo] = lum(a) > lum(b) ? [lum(a), lum(b)] : [lum(b), lum(a)];
    return (hi + 0.05) / (lo + 0.05);
  };
  const AA = 4.5;

  it("tema CLARO: fg-subtle passa sobre papel e sobre o inset", () => {
    const subtle = rgbOf("fg-subtle", 0);
    expect(ratio(subtle, [255, 255, 255])).toBeGreaterThanOrEqual(AA);
    expect(ratio(subtle, [244, 242, 238])).toBeGreaterThanOrEqual(AA);
  });

  it("tema ESCURO: fg-subtle passa sobre surface, canvas e o chip bg-fg/[0.05]", () => {
    const subtle = rgbOf("fg-subtle", 1);
    const surface = [36, 34, 32];
    // o chip que o contador de coluna usa — foi ele que reprovou por 0.02 na 1a tentativa
    const chip = surface.map((v, i) => Math.round([236, 234, 227][i] * 0.05 + v * 0.95));
    expect(ratio(subtle, surface)).toBeGreaterThanOrEqual(AA);
    expect(ratio(subtle, [26, 25, 22])).toBeGreaterThanOrEqual(AA);
    expect(ratio(subtle, chip)).toBeGreaterThanOrEqual(AA);
  });

  it("a RAMPA continua ordenada — subtle nunca fica mais escuro que muted", () => {
    for (const tema of [0, 1]) {
      const fundo = tema === 0 ? [255, 255, 255] : [36, 34, 32];
      const r = (t: string) => ratio(rgbOf(t, tema), fundo);
      expect(r("fg"), `tema ${tema}: fg > muted`).toBeGreaterThan(r("fg-muted"));
      expect(r("fg-muted"), `tema ${tema}: muted > subtle`).toBeGreaterThan(r("fg-subtle"));
    }
  });

  it("o host reserva o rodapé para o overlay flutuante não pousar sobre a nav", () => {
    expect(css).toContain("--ah-bottom-reserve");
    expect(css).toMatch(/@media \(max-width: 767px\)[\s\S]{0,120}--ah-bottom-reserve:\s*56px/);
    const overlay = readFileSync(fileURLToPath(new URL("../../../public/ah-overlay.js", import.meta.url)), "utf8");
    expect(overlay).toContain("var(--ah-bottom-reserve, 0px)");
    // O default 0px é o que mantém o overlay servível em app que não declara nada.
    expect(overlay).not.toMatch(/\.ah-bar\{[^}]*bottom:16px/);
  });

  it("a trilha do Kanban não pinta o VAZIO com a tinta mais forte", () => {
    // Estava invertido: passo vazio = `bg-fg` (~12:1, o aglomerado mais escuro da tela) e passo com
    // trabalho = âmbar a 2.19:1. Numa captura com 4 colunas zeradas, 13 pontos pretos gritavam
    // "nada aqui". Ocupado agora é MASSA DE TINTA; vazio é anel.
    const kanban = readFileSync(fileURLToPath(new URL("../KanbanBoard.tsx", import.meta.url)), "utf8");
    expect(kanban).toContain('has ? "bg-fg" : "border border-line-emphasis bg-transparent"');
    expect(kanban).not.toContain('has ? "bg-accent" : "bg-fg"');
  });

  it("nenhuma cor CRUA de nível 600 sobrou como texto (3.19:1 e 3.77:1 sobre papel)", () => {
    const dir = fileURLToPath(new URL("../..", import.meta.url));
    const walk = (d: string, acc: string[] = []): string[] => {
      for (const e of readdirSync(d)) {
        const p = join(d, e);
        if (statSync(p).isDirectory()) walk(p, acc);
        else if (/\.tsx?$/.test(p)) acc.push(p);
      }
      return acc;
    };
    const offenders = walk(dir).filter((f) => /\btext-(amber|emerald)-600\b/.test(readFileSync(f, "utf8")));
    expect(offenders, "amber-600 e emerald-600 reprovam AA como texto sobre papel — use o nível 700").toEqual([]);
  });
});

describe("BoardView — o quadro deriva o que antes era campo", () => {
  it("a ordem de preenchimento vem da POSIÇÃO no schema, não de um campo `order`", () => {
    expect(board).toContain("order={i + 1}");
    expect(board).not.toMatch(/rule\.order/);
  });

  it("nenhuma classe de grid é montada em runtime (o Tailwind varre texto de fonte)", () => {
    // `"lg:col-start-" + n` nunca seria gerada na folha — o layout tem de vir de literais.
    expect(board).not.toMatch(/["'`]lg:(col|row)-(start|span)-["'`]\s*\+/);
    expect(board).not.toMatch(/\$\{[^}]*\}\s*(col|row)-(start|span)/);
  });
});
