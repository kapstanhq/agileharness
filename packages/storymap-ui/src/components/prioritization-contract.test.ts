import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Contrato da tela de Priorização. O rig de teste é node-env sem DOM (o include é `*.test.ts` e não
// há testing-library), então o contrato de layout é asserido contra o FONTE — mesma convenção de
// `kanban-card-footer.test.ts`.
//
// Duas classes de regressão são cobertas aqui, e as duas já aconteceram nesta base:
//  1. RANKING FANTASMA — listar cards não avaliados numa lista ordenada. Sem `priorityCall` a
//     ordenação antiga caía em `localeCompare(title)` e a tela mostrava uma lista ALFABÉTICA sob um
//     cabeçalho "0 de 173 avaliadas". Ninguém percebeu porque a tela parecia certa.
//  2. DERIVA ESTÉTICA — cor crua entrando por conveniência. A identidade é warm-neutral com UM
//     acento (`--accent`), e a versão anterior tinha acumulado amber/emerald/blue/rose e seis hex
//     literais que não vinham de token nenhum.

const read = (f: string) => readFileSync(fileURLToPath(new URL(f, import.meta.url)), "utf8");
const view = read("./PrioritizationView.tsx");
const chart = read("./ValueSizeChart.tsx");

/** Só as linhas de CÓDIGO. Os comentários destes arquivos citam de propósito o que foi removido
 *  (o `localeCompare` do ranking fantasma, a paleta antiga) — proibir a palavra no comentário
 *  apagaria justamente o registro de por que aquilo não pode voltar. */
const code = (src: string) =>
  src
    .split("\n")
    .filter((l) => {
      const t = l.trimStart();
      return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");

const viewCode = code(view);
const chartCode = code(chart);

describe("Priorização — a regra de honestidade do estado vazio", () => {
  it("a lista e o gráfico só existem no ramo em que HÁ card avaliado", () => {
    // O guard `ranked.length === 0` precede o bloco que monta lista + gráfico.
    const guard = view.indexOf("ranked.length === 0");
    const grafico = view.indexOf("<ValueSizeChart");
    expect(guard, "guard de lista vazia presente").toBeGreaterThan(-1);
    expect(grafico, "gráfico presente").toBeGreaterThan(-1);
    expect(guard, "o guard vem ANTES de qualquer lista/gráfico").toBeLessThan(grafico);
  });

  it("a lista renderiza `ranked` (avaliados), NUNCA o conjunto cru de cards", () => {
    // `ranked` é filtrado por `cardWsjf(c) != null` e ordenado por comparePriority.
    expect(view).toMatch(/const scored = open\.filter\(\(c\) => cardWsjf\(c\) != null\)\.sort\(comparePriority\)/);
    expect(view).toMatch(/<ValueSizeChart cards=\{ranked\}/);
  });

  it("não-avaliados aparecem SÓ no rodapé tracejado, nunca intercalados no ranking", () => {
    const rodape = view.indexOf("ainda sem avaliação");
    const grupos = view.indexOf("TIERS.map");
    expect(rodape).toBeGreaterThan(grupos); // depois dos grupos de tier, num bloco próprio
    expect(view).toMatch(/border-dashed/);
  });

  it("NUNCA reintroduz um fallback de ordenação por título (a lista alfabética disfarçada)", () => {
    expect(viewCode).not.toContain("localeCompare(");
  });

  it("declara a cobertura (X de Y) antes de qualquer lista", () => {
    const cobertura = view.indexOf("priorizada(s)");
    const grupos = view.indexOf("TIERS.map");
    expect(cobertura).toBeGreaterThan(-1);
    expect(cobertura).toBeLessThan(grupos);
  });

  it("reporta cobertura parcial devolvida pela action em vez de engoli-la", () => {
    expect(view).toContain("sem resposta do agente");
    expect(view).toContain("preservada(s) por serem suas");
  });
});

describe("Priorização — a simplificação foi de fato feita", () => {
  it("os quatro gráficos de CLASSIFICAÇÃO saíram (a tela ORDENA, não classifica)", () => {
    for (const morto of ["ImpactEffortMatrix", "KanoCurve", "KanoLanes", "FunnelDistribution", "kanoCurveY"]) {
      expect(view, `${morto} deveria ter saído da tela`).not.toContain(morto);
    }
  });

  it("os cinco filtros independentes viraram zero", () => {
    for (const morto of ["ViewFilterBar", "useViewFilter", "applyViewFilter", "TOP_N_OPTIONS"]) {
      expect(view, `${morto} deveria ter saído`).not.toContain(morto);
    }
  });

  it("a segunda tabela e o collapse `?avancado=1` saíram", () => {
    expect(view).not.toContain("RankedTable");
    expect(view).not.toContain("ChartSection");
    expect(view).not.toContain("avancado");
  });

  it("a tela cabe em uma leitura (era 1199 linhas)", () => {
    expect(view.split("\n").length).toBeLessThan(400);
  });
});

describe("Priorização — a identidade visual não deriva", () => {
  // A régua: hierarquia por tamanho/peso/espaço, UM acento (--accent). Nada de paleta crua.
  const PROIBIDO =
    /\b(?:bg|text|border|stroke|fill|ring)-(?:amber|emerald|blue|rose|red|green|sky|violet|indigo|purple|slate|gray|zinc)-\d{2,3}\b|#[0-9a-fA-F]{6}\b|border-white\b/;

  it.each([
    ["PrioritizationView.tsx", viewCode],
    ["ValueSizeChart.tsx", chartCode],
  ])("%s não usa cor crua — só tokens", (_nome, fonte) => {
    const ofensas = fonte.split("\n").filter((l) => PROIBIDO.test(l));
    expect(ofensas.map((l) => l.trim())).toEqual([]);
  });

  it("usa o shell canônico de página das telas irmãs", () => {
    expect(view).toContain("flex min-h-screen flex-col bg-canvas");
    expect(view).toContain("mx-auto w-full max-w-4xl flex-1");
    // sem pb-24 a última linha fica atrás da barra inferior no celular
    expect(view).toMatch(/pb-24/);
  });

  it("reusa as primitivas compartilhadas em vez de recriá-las", () => {
    expect(view).toContain('from "@/lib/ui"');
    expect(view).toContain("cardEyebrow");
    expect(view).toContain("countChipCls");
  });
});

describe("ValueSizeChart — os eixos SÃO a fórmula", () => {
  it("plota tamanho no x e Custo de Atraso no y", () => {
    expect(chart).toMatch(/const xOf = \(size: Fib\)/);
    expect(chart).toMatch(/cod: w\.value \+ w\.urgency \+ w\.unlock/);
  });

  it("desenha os três tiers como FAIXAS sombreadas, não só como linhas soltas", () => {
    // Com linhas soltas o leitor não sabia qual LADO da linha cada nome descrevia. A faixa pintada
    // entre uma linha e a de cima torna "acima da linha = aquele tier" inequívoco.
    expect(chart).toMatch(/const bands: Array</);
    expect(chart).toMatch(/<polygon/);
    for (const t of ["critica", "alta", "media"]) expect(chart).toContain(`cuts.${t}`);
  });

  it("o rótulo do tier vai DENTRO da faixa, e FOGE do aglomerado de pontos", () => {
    expect(chart).toMatch(/const bandLabel =/);
    // escolher só a faixa mais alta jogava o nome exatamente onde o dado se concentra: as faixas
    // crescem com x e o backlog também. A régua é densidade primeiro, altura como desempate.
    expect(chart).toMatch(/const near = points\.filter/);
    expect(chart).toMatch(/near < best\.near \|\| \(near === best\.near && h > best\.h\)/);
    // faixa invisível ⇒ o nome SOME, em vez de flutuar num vazio que ele não descreve
    expect(chart).toMatch(/return best \? \{ x: best\.x, y: best\.y \} : null;/);
  });

  it("o teto da faixa mais alta é lido por `yOf`, não pela margem crua", () => {
    // Usar PAD.t direto deixava a margem interna pintada acima da linha clampada — uma tira clara
    // atravessando o topo do gráfico, que lia como um traço perdido.
    expect(chart).toMatch(/yOf\(hi\)\.toFixed\(1\)/);
  });

  it("o eixo Y segue o DADO, não o domínio teórico (que os dados usavam 28%)", () => {
    // O CoD teórico vai a 39, mas isso exige os três eixos no máximo; no board real ele para em 13.
    // Reservar altura para um caso que não acontece é descrever a fórmula, não o backlog.
    expect(chart).toMatch(/Math\.min\(\.\.\.cods\)/);
    expect(chart).toMatch(/Math\.max\(\.\.\.cods\)/);
    expect(chart).toMatch(/MIN_SPAN/); // guarda: board de CoD uniforme não colapsa o eixo
  });

  it("o eixo Y é LEGÍVEL — tem os valores das extremidades", () => {
    expect(chart).toMatch(/\{hi\}/);
    expect(chart).toMatch(/\{lo\}/);
  });

  it("o leque de pontos coincidentes NÃO desloca na vertical (y codifica o valor)", () => {
    // Bug real da versão anterior: a espiral movia dx E dy, e o ponto passava a mentir sobre o CoD.
    expect(chart).toMatch(/const dx = n > 1/);
    expect(chart).not.toMatch(/\bconst dy\b/);
    expect(chart).toMatch(/translate\(calc\(-50% \+ \$\{dx\}px\), -50%\)/);
  });

  it("o eixo x é ORDINAL — as seis posições de Fibonacci igualmente espaçadas", () => {
    expect(chart).toMatch(/FIB\.indexOf\(size\) \/ \(FIB\.length - 1\)/);
  });

  it("card sem ordinais não vira ponto (nunca inventa posição)", () => {
    expect(chart).toMatch(/if \(!w \|\| score == null\) return;/);
  });

  it("os cortes vêm por prop, com o default da spec — nada cravado no desenho", () => {
    expect(chart).toMatch(/cuts = DEFAULT_TIER_CUTS/);
  });

  // ── O ALVO DE TOQUE do gráfico ────────────────────────────────────────────────────────────────
  // Os pontos medem 10–12px e ABREM UM CARD. A correção óbvia (inflar a caixa para 28px) é a errada:
  // o leque de colisão afasta pontos do mesmo tier em 9px, então as caixas se engoliriam e o toque
  // abriria o card ERRADO — um alvo grande e mentiroso é pior que um alvo pequeno e honesto.
  describe("alvo de toque — o plano resolve o ponto mais próximo", () => {
    it("o PLANO recebe o ponteiro; os pontos saem do hit-test", () => {
      expect(chart, "o plano precisa do ref para converter cliente→coordenada").toMatch(/ref=\{plotRef\}/);
      expect(chart).toMatch(/onPointerMove=/);
      expect(chart).toMatch(/onClick=\{\(e\) =>/);
      expect(chart, "o ponto vira marca visual").toContain("pointer-events-none absolute rounded-full");
    });

    it("o TECLADO mantém o alvo exato — `pointer-events` não tira da tabulação", () => {
      // A regressão que isto impede: alguém trocar o <button> por <span> "já que não recebe clique".
      expect(chart).toMatch(/onClick=\{\(\) => onOpen\(p\.card\.id\)\}/);
      expect(chart).toMatch(/onFocus=\{\(\) => setHover\(p\.card\.id\)\}/);
      expect(chart).toMatch(/aria-label=\{`\$\{p\.card\.title\}/);
    });

    it("o leque do hit-test é a MESMA conta do render (uma fórmula, não duas)", () => {
      const leques = chart.match(/\(i - \(n - 1\) \/ 2\) \* 9/g) ?? [];
      expect(leques.length, "hit-test e render têm de usar o mesmo dx").toBe(2);
    });

    it("no TOQUE o primeiro toque seleciona e o segundo abre (nunca abre às cegas)", () => {
      expect(chart).toMatch(/if \(coarse && hover !== id\)/);
      expect(chart).toContain("toque de novo para abrir");
      // e o hover não nasce do mouse-enter do ponto: fonte única de estado.
      expect(chart).not.toMatch(/onMouseEnter=\{\(\) => setHover/);
    });

    it("clique no vazio não abre o card do outro lado do plano", () => {
      expect(chart).toMatch(/best\.d2 <= 72 \* 72/);
    });
  });
});
