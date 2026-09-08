import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { findRepoRoot } from "@/lib/storymap/paths";

// CONTRATO da GRADE do terminal web (`public/terminal/index.html`).
//
// A página é um ASSET estático: nenhum import de TS a alcança, o `tsc` não a lê e a suíte não a
// executava — 4 mil linhas cuja única rede de proteção era abrir o navegador. Aqui ela ganha as três
// que dão para ter sem um DOM: a SINTAXE do script (um `,` a mais deixava a página em branco em
// produção e nada acusava), a CSS parseável (ver o comentário fechado cedo demais, abaixo) e a
// função PURA que decide em que célula cada painel vai parar — extraída e EXECUTADA, não grepada.
//
// O resto é contrato sobre a fonte, no mesmo espírito de doc-surface-contract.test.ts: decisões de
// UX que uma edição distraída desfaz sem quebrar nada.

const PAGE = join(findRepoRoot(), "packages/storymap-ui/public/terminal/index.html");
const html = readFileSync(PAGE, "utf8");

const script = (() => {
  const m = html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error("a página do terminal perdeu o bloco <script> inline");
  return m[1];
})();

const css = (() => {
  const m = html.match(/<style[^>]*>([\s\S]*?)<\/style>/);
  if (!m) throw new Error("a página do terminal perdeu o bloco <style> inline");
  return m[1];
})();

describe("terminal web — a página continua parseável", () => {
  it("o script inline tem sintaxe válida", () => {
    // `new vm.Script` COMPILA sem executar: pega erro de sintaxe (que numa página estática só
    // aparece como tela branca no navegador do operador) sem precisar de DOM nenhum.
    expect(() => new vm.Script(script, { filename: "terminal/index.html" })).not.toThrow();
  });

  it("nenhum comentário CSS fecha antes da hora (o `*/` no meio derruba a regra inteira)", () => {
    // A regressão REAL que este teste tranca: um `*/` no meio de um comentário de 5 linhas jogou a
    // última frase para fora dele, e o prelúdio da regra seguinte virou prosa. O navegador não
    // avisa — ele DESCARTA a regra em silêncio, e o corte de chips do painel estreito
    // (`.pane.narrow`) ficou morto sem que nada na suíte piscasse.
    const semComentarios = css.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(semComentarios).not.toContain("*/");
  });
});

describe("terminal web — a grade aceita ficar sem terminal nenhum", () => {
  it("`closePanel` não recusa mais a última vista", () => {
    expect(html).not.toContain("Sempre fica pelo menos um painel aberto");
    expect(script).not.toMatch(/function closePanel\([^)]*\)\s*\{\s*if \(PANELS\.length <= 1\)/);
  });

  it("encerrar o terminal fecha a vista SEM perguntar quantas sobram", () => {
    // Era `if (PANELS.length > 1) closePanel(...)`: o último painel ficava de pé com o cartão de
    // morto, que o operador não conseguia dispensar.
    expect(script).not.toMatch(/if \(PANELS\.length > 1\) closePanel/);
    expect(script).toContain("closePanel(p, { killed: true });");
  });

  it("encerrar pelo seletor sempre PERGUNTA — mesmo sem painel para desenhar a pergunta", () => {
    // O `: true` que morava aqui matava sem confirmação assim que a grade ficasse vazia.
    expect(script).not.toContain('p.confirm(killQuestion(it, it.name), "Encerrar") : true');
    expect(script).toContain("window.confirm(killQuestion(it, it.name))");
  });

  it("a barra diz que a grade está vazia em vez de fingir que conecta", () => {
    expect(script).toContain('stateEl.textContent = "nenhum terminal aberto"');
  });

  it("o aviso do último encerramento tem onde aparecer (não há painel que fale por ele)", () => {
    expect(script).toContain("function pageToast(");
    expect(script).toContain("if (p) p.toast(msg, color); else pageToast(msg, color)");
    expect(css).toContain("#pagetoasts");
  });

  it("uma grade salva VAZIA é restaurada vazia, não com um shell de brinde", () => {
    expect(script).toContain("bootSessions = []; focusSession = \"\"; restoredMode = false;");
  });
});

describe("terminal web — a VAGA é a saída de uma célula sem terminal", () => {
  it("oferece as duas saídas: criar um terminal e escolher um que já existe", () => {
    expect(script).toContain('mk.textContent = "Criar terminal"');
    expect(script).toContain('pick.textContent = "Escolher um terminal"');
    expect(script).toContain("function slotCreate(");
    expect(script).toContain("function slotPick(");
  });

  it("a célula livre da grade vira vaga, e a grade sem painel nenhum também", () => {
    expect(script).toContain("else buildVaga(p, lay);");
    expect(script).toContain("if (!shown.length) buildVaga(0, lay);");
  });

  it("desistir da criação devolve a vaga em vez de deixar um painel vazio", () => {
    // O dono do desfazer é o `createSessionFlow`: ele recebeu o painel para PÔR um terminal nele, e
    // cada saída sem terminal — cancelou o nome, nome inválido, servidor recusou, rede caiu — passa
    // pelo mesmo `desfazAlvo`. Antes cada `catch` lembrava do seu e o cancelamento não lembrava de nenhum.
    expect(script).toContain(
      "var desfazAlvo = function () { if (targetPane && targetPane.session == null) closePanel(targetPane); };",
    );
    const saidas = script.match(/desfazAlvo\(\); return;/g) ?? [];
    expect(saidas.length, "as três saídas sem terminal desfazem o painel-alvo").toBe(3);
  });

  it("escolher uma linha do seletor NÃO mata o espaço reservado antes de a ação chegar nele", () => {
    // Defeito que existia ANTES da vaga e que ela herdaria: `runPalette` fechava a paleta — o que
    // desfaz o painel reservado — e SÓ ENTÃO executava a linha, que então caía no painel vizinho.
    // Dividir a tela e escolher um terminal trocava o terminal do painel de ORIGEM e descartava o
    // novo; ou seja, o split não fazia nada.
    expect(script).toMatch(/var reservado = paletteForNew \? paletteTarget : null;\s*\n\s*paletteForNew = false;\s*\n\s*closePalette\(\);\s*\n\s*it\.run\(\);/);
    // e a linha usa o alvo CAPTURADO na montagem, não o global que closePalette já zerou
    expect(script).toContain("if (alvo && s.name !== alvo.session) alvo.attach(s.name);");
    expect(script).not.toContain("var t = paletteTarget || focusedPane();");
  });

  it("'Criar um terminal novo…' só herda o espaço quando ele está VAZIO", () => {
    // Herdar um painel COM terminal faria o criar atropelar o terminal em foco em vez de abrir um
    // ao lado — o oposto do que a linha promete.
    expect(script).toContain("void createSessionFlow(alvo && alvo.session == null ? alvo : null);");
  });

  it("a vaga tem pele própria (o buraco preto não dizia se era vazio ou defeito)", () => {
    expect(css).toContain(".vaga");
    expect(css).toMatch(/\.vaga::before[\s\S]*?border: 1px dashed/);
  });
});

// ── assignSlots: a única regra PURA da grade, extraída da página e executada de verdade ──
//
// Ela responde "que painel fica em que célula" — e é o que faz `Criar terminal` numa vaga abrir o
// terminal NAQUELA vaga, em vez de no primeiro buraco. Sem executá-la, o contrato seria só a
// palavra do grep.
type Pane = { slot: number | null; nome: string };
const assignSlots = (() => {
  const start = script.indexOf("function assignSlots(");
  if (start < 0) throw new Error("assignSlots sumiu da página do terminal");
  let depth = 0, end = -1;
  for (let i = script.indexOf("{", start); i < script.length; i++) {
    if (script[i] === "{") depth++;
    else if (script[i] === "}" && --depth === 0) { end = i + 1; break; }
  }
  if (end < 0) throw new Error("não consegui delimitar assignSlots");
  const fonte = script.slice(start, end);
  const ctx: Record<string, unknown> = {};
  vm.runInNewContext(`${fonte}; __out = assignSlots;`, ctx);
  return (ctx.__out ?? ctx.assignSlots) as (
    shown: Pane[], slots: number, honor: boolean,
  ) => Array<Pane | undefined>;
})();

const pane = (nome: string, slot: number | null = null): Pane => ({ nome, slot });
// DENSIFICA de propósito: assignSlots devolve um array ESPARSO (`new Array(slots)` com buracos), e
// `.map` pula buraco em vez de visitá-lo. É exatamente disso que o layout depende — a célula sem
// painel lê `undefined`, cai no `else` e vira vaga —, então o teste lê o buraco em vez de sumir com ele.
const nomes = (r: Array<Pane | undefined>) =>
  Array.from({ length: r.length }, (_, i) => r[i]?.nome ?? null);

describe("assignSlots — que painel fica em que célula", () => {
  it("sem preferência, empacota na ordem e deixa o resto vago", () => {
    expect(nomes(assignSlots([pane("a")], 4, true))).toEqual(["a", null, null, null]);
  });

  it("um painel que nasceu na célula 3 VOLTA para a 3 — é o contrato do 'criar aqui'", () => {
    expect(nomes(assignSlots([pane("a", 3)], 4, true))).toEqual([null, null, null, "a"]);
  });

  it("no arranjo automático a preferência é ignorada (ali a grade é derivada da contagem)", () => {
    expect(nomes(assignSlots([pane("a", 3)], 4, false))).toEqual(["a", null, null, null]);
  });

  it("preferência que não cabe no arranjo atual cai para a primeira célula livre", () => {
    // 2×2 → 1×2: a célula 3 não existe mais. O painel não pode sumir da tela por isso.
    expect(nomes(assignSlots([pane("a", 3)], 2, true))).toEqual(["a", null]);
  });

  it("dois painéis disputando a mesma célula: um fica, o outro cai na próxima livre", () => {
    expect(nomes(assignSlots([pane("a", 1), pane("b", 1)], 3, true))).toEqual(["b", "a", null]);
  });

  it("a grade cheia não deixa vaga nenhuma", () => {
    const r = assignSlots([pane("a", 2), pane("b"), pane("c"), pane("d")], 4, true);
    expect(nomes(r).filter(Boolean).sort()).toEqual(["a", "b", "c", "d"]);
    expect(nomes(r)[2]).toBe("a");
  });

  it("grade sem painel nenhum: só vagas", () => {
    expect(nomes(assignSlots([], 4, true))).toEqual([null, null, null, null]);
  });
});
