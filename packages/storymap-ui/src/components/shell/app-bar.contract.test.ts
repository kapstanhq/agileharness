import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { appBarCrumb, appBarSep } from "./app-bar-shell";

// O CONTRATO da barra do topo, contra o fonte (o rig é node sem DOM — ver chat/jido-composer.contract.test.ts). Fixa
// os dois defeitos que a conferência visual da fase 1 achou e que nenhum teste puro pegaria: a marca compacta
// aparecendo COLADA ao lockup no computador, e o chevron do projeto atropelando a barra "/" em 390px.

const src = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const mark = src("./BrandMark.tsx");
const bar = src("./AppBar.tsx");
const project = src("./ProjectSwitcher.tsx");
const group = src("./GroupSwitcher.tsx");

describe("a marca", () => {
  it("no computador só o lockup Agile·HARNESS; a marca compacta só no celular", () => {
    expect(bar).toMatch(/<span className="hidden md:inline-flex">\s*<AgileHarnessLogo size=\{13\} \/>\s*<\/span>\s*<BrandMark className="md:hidden" \/>/);
  });
  it("o `display` da marca compacta é CLASSE — um display inline venceria o `md:hidden` de quem a monta", () => {
    expect(mark).not.toMatch(/style=\{\{[^}]*display/);
    expect(mark).toMatch(/className=\{cn\("block", className\)\}/);
  });
});

describe("a árvore projeto / grupo em 390px", () => {
  it("quem encolhe é o GATILHO do projeto (trunca o nome), não só o invólucro — o chevron não transborda sobre o «/»", () => {
    expect(project).toMatch(/<div ref=\{ref\} className="relative flex min-w-0">/);
    // o teto do gatilho devolve os 6px do `-ml-1.5` dele: com `max-w-full` o nome curto truncava com espaço sobrando
    expect(project).toMatch(/className=\{cn\(appBarCrumb, "max-w-\[calc\(100%\+6px\)\] sm:max-w-\[18rem\]"/);
    expect(appBarCrumb).toContain("-ml-1.5");
    // no celular o nome do board QUEBRA em até duas linhas (cabe no alvo de 40px) em vez de virar «Livraria Aur…» —
    // mas só nos espaços: `overflow-wrap:anywhere` partia a palavra no meio («AgileHa / rness» em 390px)
    expect(project).toMatch(
      /<span title=\{config\.name\} className="[^"]*max-sm:line-clamp-2[^"]*sm:truncate">\s*\{config\.name\}\s*<\/span>/,
    );
    expect(project).not.toMatch(/max-sm:\[overflow-wrap:anywhere\]/);
  });
  it("o NOME do board tem a prioridade em 390px: o grupo cede a largura PRIMEIRO (trunca até «S…»; abaixo de 360px, até o chevron) e só então o board encolhe", () => {
    expect(group).not.toMatch(/<Icon /);
    expect(group).toMatch(/<span className="min-w-0 max-w-\[76px\] truncate max-\[359px\]:hidden sm:max-w-none">\{label\}<\/span>/);
    // o nome do grupo não some para o leitor de tela nem para o mouse
    expect(group).toMatch(/aria-label=\{group \? `Grupo \$\{label\} — trocar de grupo` : "Escolher um grupo"\}/);
    expect(group).toMatch(/title=\{group \? `\$\{label\} — trocar de grupo` : "Escolher um grupo"\}/);
    // peso de encolhimento 10000 contra o 1 do projeto (com 100 o projeto ainda cedia uma fração de pixel e o
    // «Livraria» virava «Livrari…» em 390px); o piso é «S…» (só o chevron deixava um pedaço de letra cortada) e,
    // abaixo de 360px, o chevron sem o nome
    expect(group).toMatch(/<div ref=\{ref\} className="relative flex min-w-\[1\.375rem\] shrink-\[10000\] min-\[360px\]:min-w-\[2\.75rem\]">/);
    expect(project).not.toMatch(/<div ref=\{ref\} className="[^"]*shrink-\[/);
    expect(appBarSep).toContain("shrink-0");
  });
  it("a lista de grupos nunca passa da tela no celular: ancorada pela direita e com teto de largura", () => {
    expect(group).toMatch(/absolute right-\[-6px\][^"]*max-w-\[calc\(100vw-32px\)\][^"]*sm:left-\[-6px\] sm:right-auto/);
  });
  it("a lista de projetos mostra o nome INTEIRO (quebra linha, nunca «…»)", () => {
    expect(project).toMatch(/<span className="min-w-0 flex-1 \[overflow-wrap:anywhere\]">\{b\.name\}<\/span>/);
    expect(project).not.toMatch(/truncate">\{b\.name\}/);
  });
  it("numa tela sem grupo (o Inbox do board) o seletor não finge que a tela é um grupo: «Grupos», apagado, lista sem ✓", () => {
    expect(group).toMatch(/!group && "font-medium text-fg-muted"/);
    expect(group).toMatch(/const current = group\?\.id \?\? null;/);
    expect(group).toMatch(/aria-checked=\{active\}/);
  });
});
