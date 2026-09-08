// O CONTRATO DE ANIMAÇÃO do mascote, em teste. Duas garantias que antes só existiam como raciocínio:
//
//   A. UM ELEMENTO, UMA ANIMAÇÃO — nenhum elemento recebe duas classes que declaram `animation`.
//   B. `prefers-reduced-motion` — nenhuma animação escapa do congelamento, e nada congela INVISÍVEL.
//
// ── A. Um elemento, uma animação ─────────────────────────────────────────────────────────────────
//
// `animation` é propriedade-ATALHO: duas regras que a declaram no mesmo elemento não somam, a que
// vier depois na folha ANULA a outra. É por isso que o `jido-swap` (a troca de pose) mora no `<svg>`
// e o `jido-anim-shake` (o tremor do pânico) no `<g>` de dentro — se os dois caíssem no mesmo
// elemento, o pânico comeria a troca ou vice-versa, dependendo da ordem do CSS. Um humor perderia
// silenciosamente metade da sua animação, e o defeito só apareceria em UM humor.
//
// Duas revisões independentes (2026-08-03) apontaram esse risco e nenhuma conseguiu FECHÁ-LO: para
// descartar era preciso abrir o componente e casar, na cabeça, quais classes caem em qual elemento.
// Um invariante que exige leitura cruzada de dois arquivos não é um invariante — é uma esperança.
// Aqui ele passa a ser verificado: cada grupo de classes que aterrissa num MESMO elemento pode ter
// no máximo uma que anime.

// ── B. prefers-reduced-motion ────────────────────────────────────────────────────────────────────
//
// Este teste nasceu de uma revisão independente (2026-08-03) que apontou como CRÍTICO um defeito que
// não existia: "o `.jido-cursor` fica em opacity 0.72 sob reduced-motion, invisível". Medimos em
// Chrome headless com `--force-prefers-reduced-motion` e o valor computado é **1** — cancelar uma
// animação devolve o valor-base do CSS, e uma keyframe sem `fill-mode` não persiste.
//
// O revisor não estava sendo desatento: para chegar a "está tudo bem" era preciso encadear três
// fatos (o `animation: none` cancela · a keyframe não tem fill-mode · logo vale o valor-base, que é
// o default 1). Código que exige uma dedução de três passos para provar que é acessível não é
// acessível o bastante — a próxima pessoa refaz a dedução e pode errar. Então a garantia deixou de
// morar num raciocínio e passou a morar aqui.
//
// São DUAS regras, e as duas são estáticas de propósito (a suíte não pode depender de navegador):
//
//  1. COBERTURA — toda classe do mascote que declara `animation` é cancelada pelo bloco de
//     reduced-motion (direto ou pelo curinga `.jido-mascot *`). Uma animação nova que nasça fora da
//     lista é movimento periférico que ninguém pediu, na tela de quem pediu para a tela parar.
//  2. NADA PRESO — quem declara um valor ESTÁTICO que esconde (opacity < 1, ou um transform que
//     zera/desloca) fora das keyframes precisa de um reset EXPLÍCITO dentro do bloco, porque nesse
//     caso o valor-base É o estado escondido. É o que vale para `.jido-eyelid`/`.jido-lip`
//     (`scaleY(0)` = pálpebra recolhida, o quadro de repouso certo) e para `.jido-stream`, cuja
//     animação usa `both` e congelaria em `opacity: 0`.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Todo arquivo com uma das extensões, recursivamente — ignorando testes e diretórios ocultos. */
function arquivos(dir: string, ext: readonly string[], out: string[] = []): string[] {
  for (const entrada of readdirSync(dir)) {
    if (entrada.startsWith(".") || entrada === "node_modules") continue;
    const p = join(dir, entrada);
    if (statSync(p).isDirectory()) arquivos(p, ext, out);
    else if (ext.some((e) => entrada.endsWith(e)) && !/\.test\.tsx?$/.test(entrada)) out.push(p);
  }
  return out;
}

const CSS = readFileSync(new URL("./globals.css", import.meta.url).pathname, "utf8");

/** O corpo do `@media (prefers-reduced-motion: reduce)`, com aninhamento equilibrado por contagem. */
function freezeBlock(css: string): string {
  const start = css.indexOf("@media (prefers-reduced-motion: reduce)");
  expect(start, "o bloco de reduced-motion sumiu do globals.css").toBeGreaterThan(-1);
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error("bloco de reduced-motion sem fechamento");
}

/**
 * Regras `seletor { corpo }` de um trecho de CSS, ignorando `@keyframes` (que não são regras de
 * elemento).
 *
 * ⚠️ Os COMENTÁRIOS saem ANTES de qualquer coisa, e não depois de casar o seletor. Este arquivo
 * documenta o próprio código e alguns comentários contêm chaves (`key={mood}`) — com eles no texto,
 * o casamento `[^{}]+{…}` do seletor quebra e a regra logo abaixo some da varredura em SILÊNCIO. Foi
 * assim que a primeira versão deste teste "não viu" o `.jido-swap` e passou verde sem cobrir nada.
 */
function rules(css: string, comentariosAntes = true): { selector: string; body: string }[] {
  const out: { selector: string; body: string }[] = [];
  const base = comentariosAntes ? css.replace(/\/\*[\s\S]*?\*\//g, "") : css;
  const limpo = base.replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
  for (const m of limpo.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    // `comentariosAntes: false` reproduz o BUG histórico (limpar o comentário só do seletor, depois
    // de já ter casado a regra) — é o parâmetro que o teste de mutação usa para provar o canário.
    const selector = (comentariosAntes ? m[1] : m[1].replace(/\/\*[\s\S]*?\*\//g, "")).trim();
    if (selector.startsWith("@")) continue;
    out.push({ selector, body: m[2] });
  }
  return out;
}

const FREEZE = freezeBlock(CSS);
/** Os seletores que o bloco cancela ou reseta, normalizados um por linha. */
const CONGELADOS = rules(FREEZE).flatMap((r) => r.selector.split(",").map((s) => s.trim()));

/**
 * O INVENTÁRIO de classes que animam, com os dois eixos onde o parser já falhou de verdade.
 *
 * Os defaults são o comportamento CORRETO. Os outros valores existem para o teste de mutação lá
 * embaixo poder reproduzir cada bug histórico e provar que o canário o pega — sem isso, "os canários
 * funcionam" seria uma afirmação minha, e este arquivo inteiro é sobre não aceitar afirmação no
 * lugar de verificação.
 */
function inventario({ comentariosAntes = true, ignorarFreezeENone = true } = {}): string[] {
  const fonte = ignorarFreezeENone ? CSS.replace(FREEZE, "") : CSS;
  return [
    ...new Set(
      rules(fonte, comentariosAntes)
        .filter((r) =>
          ignorarFreezeENone
            ? /(^|[\s;])animation\s*:\s*(?!none)/.test(r.body)
            : /(^|[\s;])animation\s*:/.test(r.body),
        )
        .flatMap((r) => r.selector.split(",").map((s) => s.trim()))
        .map((s) => s.match(/^\.[\w-]+/)?.[0] ?? "")
        .filter((s) => s.startsWith(".jido-")),
    ),
  ].sort();
}

const FACE = readFileSync(new URL("../components/copilot/CopilotFace.tsx", import.meta.url).pathname, "utf8");

/**
 * As classes `.jido-*` que de fato DECLARAM uma animação — as que competem pela propriedade-atalho.
 *
 * Duas exclusões, as duas necessárias: o bloco de reduced-motion (que só CANCELA) e qualquer
 * `animation: none`. Sem elas o `.jido-mascot` entrava na lista por causa do próprio congelamento e
 * o teste acusava colisão onde não há — um falso positivo que teria me feito "consertar" um arranjo
 * correto.
 */
const ANIMADAS = new Set(inventario());

/**
 * Os GRUPOS de classes que aterrissam num mesmo elemento, lidos do componente.
 *
 * Cada `className={cn(…)}` (ou `className="…"`) é UM elemento. Pegamos os literais de string de
 * dentro de cada chamada e ficamos com os `jido-*` — é o conjunto que o navegador vai ver junto.
 * Expressões dinâmicas (`className` repassado por quem chama) ficam de fora aqui e são cobertas
 * pelo teste seguinte, que varre a árvore inteira.
 */
function gruposDeClasse(jsx: string): { onde: string; classes: string[] }[] {
  const grupos: { onde: string; classes: string[] }[] = [];
  for (const m of jsx.matchAll(/className=(?:"([^"]*)"|\{([^{}]*)\})/g)) {
    const [literal, expressao] = [m[1], m[2]];
    const corpo = literal ?? expressao ?? "";
    // `className="a b"` já vem SEM aspas (a captura as consumiu). Qualquer `{…}` — `cn(…)`, uma
    // ternária (`cond ? "x" : undefined`), um `&&` — entrega os literais entre aspas de dentro.
    const bruto = literal !== undefined ? [literal] : [...(expressao ?? "").matchAll(/"([^"]*)"/g)].map((s) => s[1]);
    const classes = bruto
      .flatMap((s) => s.split(/\s+/))
      .filter((c) => c.startsWith("jido-"))
      .map((c) => `.${c}`);
    if (classes.length) grupos.push({ onde: corpo.slice(0, 60).replace(/\s+/g, " "), classes });
  }
  return grupos;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// O PARSER NÃO PODE FALHAR EM SILÊNCIO — a trava da trava.
//
// Tudo aqui embaixo é regex sobre TEXTO (CSS e JSX), não sobre DOM real. É uma escolha: a suíte não
// pode depender de navegador. Mas o modo de falha dessa escolha é o pior que existe — quando a regex
// não entende um trecho, ela não erra: ela DEIXA DE VER, e o teste fica verde cobrindo menos do que
// anuncia. Não é hipótese, aconteceu duas vezes ao escrever este arquivo (um comentário com `{mood}`
// escondeu o `.jido-swap`; o `animation: none` do congelamento inventou uma colisão inexistente), e
// uma revisão independente marcou justamente essa categoria como o desconto residual da nota.
//
// A resposta são três canários. Nenhum deles impede a regex de quebrar; os três garantem que, se ela
// quebrar, o teste fica VERMELHO em vez de mudo:
//
//  1. INVENTÁRIO FIXADO — o conjunto de classes que animam é comparado com uma lista escrita à mão.
//     Sumiu uma? A varredura deixou de cobri-la. Apareceu uma nova? Ela precisa de uma decisão
//     humana (entra no congelamento? colide com alguma?), não de um `toBeGreaterThan` complacente.
//  2. DUPLA DERIVAÇÃO — os `@keyframes` do arquivo e as regras que os USAM são extraídos por
//     caminhos independentes e têm de casar exatamente. Uma regex que perde uma regra rompe o
//     casamento; duas derivações erradas do mesmo jeito é bem mais improvável que uma.
//  3. GRUPOS FIXADOS — os conjuntos de classes por elemento lidos do JSX também são comparados com
//     o esperado, pelo mesmo motivo, mais um teste que prova que o leitor entende AS TRÊS formas de
//     `className` que o componente usa (literal, `cn(…)`, ternária) — senão "os grupos batem"
//     poderia significar apenas "a regex segue cega às mesmas coisas de sempre".
//
// E o canário do canário: "estes canários pegam as duas quebras reais" seria mais uma AFIRMAÇÃO se
// ficasse só aqui em cima. O `inventario()` aceita os dois eixos de quebra como parâmetro, e o teste
// "os canários PEGAM as duas quebras reais" reintroduz cada bug e verifica o sintoma exato — roda em
// toda execução da suíte, como qualquer outro teste. Prosa não prova nada; era esse o ponto do
// arquivo inteiro, e valia para o próprio arquivo.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("os canários do parser — quebrar é permitido, quebrar calado não", () => {
  it("os canários PEGAM as duas quebras reais — provado aqui, não afirmado em comentário", () => {
    // O teste de mutação, executável. Uma revisão independente notou, com razão, que a alegação
    // "medi os canários reintroduzindo os bugs" vivia só na prosa do cabeçalho: o leitor tinha de
    // ACREDITAR. Prosa não prova nada — é a tese deste arquivo, e ela vale para o próprio arquivo.
    // Agora os dois defeitos históricos são reproduzidos de verdade e o sintoma exato é verificado.
    const correto = inventario();

    // BUG 1 (real, 2026-08-03): limpar os comentários DEPOIS de casar a regra. Um comentário deste
    // CSS contém `{mood}`, as chaves quebram o casamento `[^{}]+{…}` e a regra seguinte some.
    const comBugDoComentario = inventario({ comentariosAntes: false });
    expect(comBugDoComentario, "o bug do comentário deixaria o inventário IGUAL — canário cego").not.toEqual(correto);
    expect(comBugDoComentario, "o sintoma exato: o `.jido-swap` desaparece da varredura").not.toContain(".jido-swap");
    expect(correto, "…e o parser correto o enxerga").toContain(".jido-swap");

    // BUG 2 (real, 2026-08-03): contar o bloco de reduced-motion e o `animation: none`. O
    // congelamento faz o `.jido-mascot` parecer animado e o teste acusa colisão onde não há.
    const comBugDoNone = inventario({ ignorarFreezeENone: false });
    expect(comBugDoNone, "o bug do `animation: none` deixaria o inventário IGUAL — canário cego").not.toEqual(correto);
    expect(comBugDoNone, "o sintoma exato: o `.jido-mascot` entra como se animasse").toContain(".jido-mascot");
    expect(correto, "…e o parser correto o mantém fora").not.toContain(".jido-mascot");
  });

  it("o inventário de classes que animam é EXATAMENTE o esperado", () => {
    // Mexeu no CSS e este teste ficou vermelho? Ótimo — era para ficar. Atualize a lista DEPOIS de
    // decidir se a classe nova precisa entrar no bloco de reduced-motion e se ela pode dividir
    // elemento com alguma das outras.
    expect([...ANIMADAS].sort()).toEqual([
      ".jido-anim-float",
      ".jido-anim-pulse",
      ".jido-anim-shake",
      ".jido-blink",
      ".jido-cursor",
      ".jido-stream",
      ".jido-swap",
      ".jido-talk",
    ]);
  });

  it("todo `@keyframes` é usado, e todo uso tem `@keyframes` — duas derivações que têm de casar", () => {
    // A derivação A: os nomes declarados. A derivação B: os nomes referenciados no atalho `animation`.
    // Elas passam por caminhos diferentes do texto; se a regex de regra perder uma regra, o nome dela
    // fica órfão do lado das declaradas e o teste acusa. É o canário que teria pego, sozinho, o bug do
    // comentário com `{mood}` que escondia o `.jido-swap`.
    const declarados = new Set([...CSS.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]));
    const usados = new Set(
      rules(CSS.replace(FREEZE, ""))
        .map((r) => r.body.match(/(^|[\s;])animation\s*:\s*([\w-]+)/)?.[2])
        .filter((n): n is string => Boolean(n) && n !== "none"),
    );
    expect(declarados.size, "nenhum @keyframes encontrado — o parser do CSS quebrou").toBeGreaterThan(5);
    expect([...usados].sort(), "há `animation:` apontando para keyframes que não existem").toEqual(
      [...usados].filter((n) => declarados.has(n)).sort(),
    );
    expect([...declarados].sort(), "há `@keyframes` que ninguém usa — ou a regra sumiu da varredura").toEqual(
      [...declarados].filter((n) => usados.has(n)).sort(),
    );
  });

  it("os grupos de classe lidos do componente são EXATAMENTE os esperados", () => {
    // Mesmo raciocínio do inventário, do lado do JSX: um `className` escrito de um jeito que a regex
    // não prevê (template literal, `clsx` aninhado, spread) desapareceria da varredura em silêncio.
    const grupos = gruposDeClasse(FACE)
      .map((g) => [...g.classes].sort().join(" "))
      .sort();
    expect(grupos).toEqual([
      ".jido-anim-shake", //            o <g> que treme (glitch/pânico)
      ".jido-blink .jido-eyelid", //    a pálpebra
      ".jido-cursor", //                o <span> do mascote que escreve no chat
      ".jido-lip .jido-talk", //        o lábio da fala
      ".jido-mascot .jido-swap", //     o <svg>: o desenho + a troca de pose
    ]);
  });

  it("o leitor de `className` entende as TRÊS formas que o JSX usa", () => {
    // O positivo do canário: sem isto, "os grupos batem" poderia significar só "a regex continua
    // sem enxergar as mesmas coisas de sempre". Aqui provamos que ela lê cada forma de verdade.
    const lido = (jsx: string) => gruposDeClasse(jsx).map((g) => g.classes.join(" "));
    expect(lido('<i className="jido-eyelid jido-blink"/>'), "literal com duas classes").toEqual([
      ".jido-eyelid .jido-blink",
    ]);
    expect(lido('<i className={cn("jido-mascot", k && "jido-swap")}/>'), "cn com condicional").toEqual([
      ".jido-mascot .jido-swap",
    ]);
    expect(lido('<i className={shake ? "jido-anim-shake" : undefined}/>'), "ternária").toEqual([".jido-anim-shake"]);
  });
});

describe("um elemento, uma animação — `animation` é atalho e não soma", () => {
  it("nenhum elemento do mascote recebe DUAS classes que animam", () => {
    const grupos = gruposDeClasse(FACE);
    expect(grupos.length, "não achei nenhum grupo de classes .jido-* — o parser do JSX quebrou").toBeGreaterThan(2);
    for (const { onde, classes } of grupos) {
      const animam = classes.filter((c) => ANIMADAS.has(c));
      expect(
        animam.length,
        `duas animações no MESMO elemento (${animam.join(" + ")}) em \`${onde}\` — a segunda regra da ` +
          `folha ANULA a primeira, e um humor perderia metade do movimento em silêncio`,
      ).toBeLessThanOrEqual(1);
    }
  });

  it("o arranjo é o esperado: a TROCA no <svg>, o TREMOR no <g> de dentro", () => {
    // O caso concreto que as revisões não conseguiram fechar. Aqui ele fica escrito: as duas classes
    // existem, as duas animam, e elas vivem em grupos DIFERENTES — logo, em elementos diferentes.
    expect(ANIMADAS, "jido-swap deixou de animar").toContain(".jido-swap");
    expect(ANIMADAS, "jido-anim-shake deixou de animar").toContain(".jido-anim-shake");
    const grupos = gruposDeClasse(FACE);
    const comSwap = grupos.find((g) => g.classes.includes(".jido-swap"));
    const comShake = grupos.find((g) => g.classes.includes(".jido-anim-shake"));
    expect(comSwap, "ninguém aplica jido-swap").toBeDefined();
    expect(comShake, "ninguém aplica jido-anim-shake").toBeDefined();
    expect(comSwap!.classes, "a troca acompanha o `.jido-mascot` (o <svg>)").toContain(".jido-mascot");
    expect(comShake!.classes, "o tremor NÃO pode dividir elemento com a troca").not.toContain(".jido-swap");
  });

  it("a regra vale na ÁRVORE INTEIRA, não só no componente do mascote", () => {
    // O `CopilotFace` aceita um `className` do chamador, e outras telas aplicam classes `jido-*` por
    // conta própria (o `.jido-stream` do texto que chega, no HitlConversation). Nenhuma delas pode
    // juntar duas animações no mesmo elemento — a colisão do atalho `animation` não sabe de onde a
    // classe veio. Então a varredura é da árvore toda, não de um arquivo.
    const tsx = arquivos(new URL("..", import.meta.url).pathname, [".tsx"]);
    expect(tsx.length, "a varredura não achou .tsx nenhum — escopo quebrado").toBeGreaterThan(20);
    for (const f of tsx) {
      for (const { onde, classes } of gruposDeClasse(readFileSync(f, "utf8"))) {
        const animam = classes.filter((c) => ANIMADAS.has(c));
        expect(
          animam.length,
          `${f.split("/src/")[1]}: duas animações no mesmo elemento (${animam.join(" + ")}) em \`${onde}\``,
        ).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("prefers-reduced-motion — o mascote para de verdade", () => {
  it("toda animação do mascote é CANCELADA pelo bloco", () => {
    // `.jido-mascot *` cobre qualquer descendente do desenho (pálpebra, lábio, glifo, grupo de
    // tremor), então uma classe só precisa aparecer NOMINALMENTE se ela vive fora do SVG — como o
    // `.jido-cursor` (o `<span>` em volta) e o `.jido-stream` (o texto da resposta).
    expect(CONGELADOS, "o curinga `.jido-mascot *` saiu da lista").toContain(".jido-mascot *");
    expect(CONGELADOS, "`.jido-mascot` saiu da lista").toContain(".jido-mascot");

    // Quem está DENTRO do SVG a gente lê do componente, não de uma lista à mão que apodrece: tudo
    // que aparece depois da abertura do `<svg className={cn("jido-mascot"…)}>` está no elemento ou
    // abaixo dele, e portanto pego pelo par nominal+curinga.
    const jsx = readFileSync(new URL("../components/copilot/CopilotFace.tsx", import.meta.url).pathname, "utf8");
    const abreSvg = jsx.indexOf('"jido-mascot"');
    expect(abreSvg, "não achei o `<svg>` do mascote em CopilotFace.tsx").toBeGreaterThan(-1);
    // Uma string de className pode carregar MAIS de uma classe ("jido-eyelid jido-blink"), então
    // pegamos os literais inteiros e separamos por espaço — regex ancorada na aspa perderia a segunda.
    const noSvg = new Set(
      [...jsx.slice(abreSvg).matchAll(/"([^"]*)"/g)]
        .flatMap((m) => m[1].split(/\s+/))
        .filter((t) => t.startsWith("jido-"))
        .map((t) => `.${t}`),
    );
    expect(noSvg.size, "nenhuma classe dentro do SVG — o parser do componente quebrou").toBeGreaterThan(2);

    const animadas = rules(CSS)
      .filter((r) => /(^|[\s;])animation\s*:/.test(r.body) && /\.jido-/.test(r.selector))
      .flatMap((r) => r.selector.split(",").map((s) => s.trim()))
      .filter((s) => s.startsWith(".jido-"));
    expect(animadas.length, "nenhuma classe .jido-* anima — o parser do CSS quebrou").toBeGreaterThan(4);

    for (const sel of new Set(animadas)) {
      const classe = sel.match(/^\.[\w-]+/)![0];
      const nominal = CONGELADOS.some((c) => c === sel || c === classe || c.startsWith(`${classe} `));
      // `.jido-anim-pulse > *` e afins: a classe-raiz está no SVG ⇒ ela e os filhos caem no curinga.
      const dentroDoSvg = noSvg.has(classe);
      expect(
        nominal || dentroDoSvg,
        `${sel} anima, não está nominalmente congelada e não vive dentro do SVG do mascote — ` +
          `quem pediu para a tela parar veria movimento`,
      ).toBe(true);
    }
  });

  it("quem tem valor-base ESCONDIDO ganha reset explícito; quem não tem, não precisa", () => {
    // A régua que responde de uma vez a pergunta "isso congela invisível?":
    //   base escondido  ⇒ TEM de aparecer com `!important` dentro do bloco;
    //   base visível    ⇒ cancelar a animação já devolve o visível (é o caso do `.jido-cursor`,
    //                     medido em Chrome: opacity computada = 1 sob reduced-motion).
    const escondeEstaticamente = (body: string) =>
      /(^|[\s;])opacity\s*:\s*0?\.\d/.test(body) ||
      /(^|[\s;])opacity\s*:\s*0\s*[;}]/.test(body) ||
      /transform\s*:\s*(scale[XY]?\(0|scale\(0)/.test(body);

    const resetados = new Set(
      rules(FREEZE)
        .filter((r) => /!important/.test(r.body))
        .flatMap((r) => r.selector.split(",").map((s) => s.trim())),
    );

    for (const r of rules(CSS)) {
      if (!/\.jido-/.test(r.selector) || !escondeEstaticamente(r.body)) continue;
      for (const sel of r.selector.split(",").map((s) => s.trim())) {
        expect(
          resetados.has(sel),
          `${sel} tem valor-base que ESCONDE e nenhum reset no bloco de reduced-motion — congelaria invisível`,
        ).toBe(true);
      }
    }

    // E o contrapositivo, nomeado: o `.jido-cursor` NÃO declara opacidade estática, e é por isso —
    // e só por isso — que ele pode ficar fora dos resets. Se alguém lhe der um `opacity` de base,
    // a regra acima passa a cobrá-lo automaticamente.
    const cursor = rules(CSS).find((r) => r.selector === ".jido-cursor");
    expect(cursor, ".jido-cursor sumiu").toBeDefined();
    expect(/opacity\s*:/.test(cursor!.body), ".jido-cursor ganhou opacidade estática — agora precisa de reset").toBe(
      false,
    );
  });

  it("o texto que chega volta VISÍVEL — a animação dele usa `both` e congelaria em opacity 0", () => {
    // O único caso do arquivo em que cancelar não basta: `jido-text-in` tem `both`, e `from` é
    // `opacity: 0`. Sem o reset, quem pede menos movimento receberia a resposta do Jido em branco.
    expect(CSS).toMatch(/animation:\s*jido-text-in[^;]*both/);
    expect(FREEZE).toMatch(/opacity:\s*1\s*!important/);
    expect(FREEZE).toMatch(/transform:\s*none\s*!important/);
  });
});
