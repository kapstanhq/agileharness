// typography.ts — THE typographic scale of the reading surfaces (the "documento" look).
//
// Três consumidores, UMA escala:
//   • <Markdown variant="doc">  — uma STRING markdown → blocos ricos (corpo do card, plano, projeções)
//   • <DocRead>                 — o IR DocModel → blocos (o lado de leitura do editor Notion-like)
//   • os WIDGETS de doc         — os blocos interativos que dividem a mesma coluna (bloqueios,
//                                 histórico, trajeto, design canvas), cujos títulos de seção precisam
//                                 ler como títulos DAQUELE documento, não como cromo de widget.
// Eles renderizam lado a lado na MESMA coluna, então um segundo conjunto de números aparece na hora
// como desalinhamento visível. Os números moram AQUI.
//
// ── A escala é a do Notion (medida do produto, não inventada) ────────────────────────────────────
// Título de página 40 · H1 30 · H2 24 · H3 20 · corpo 16/1.6, títulos em peso 600 e caixa-alta em
// lugar NENHUM. A hierarquia se faz por TAMANHO, PESO e ESPAÇO — nunca por caixa colorida (a
// identidade do pacote já diz isso em globals.css: "hierarquia por tamanho/peso/espaço, não por
// cor"). No celular cada degrau desce um passo, porque 40px come meia tela.
//
// ── O mapa de NÍVEL → degrau (uma tabela só, para as duas superfícies) ───────────────────────────
// Um `#` numa string markdown e um `heading level 1` do IR são a MESMA coisa e precisam sair do
// mesmo tamanho — antes não saíam (o `## X` do corpo de um card rendia 26px por <Markdown> e 22px
// por <DocRead>, o degrau que fazia a costura aparecer). A tabela canônica:
//     `#`   / level 1 → DOC.title  (o título do documento)
//     `##`  / level 2 → DOC.h1     (uma seção)
//     `###` / level 3 → DOC.h2     (uma subseção)
//     `####`          → DOC.h3
// O rótulo de um bloco `section` ancorado entra como SEÇÃO (DOC.h1) — é disso que ele sempre foi
// feito; o que mudou é que ele deixou de ser uma caixa com etiqueta em caixa-alta.
//
// Tailwind varre este arquivo por strings LITERAIS de classe (`content: ./src/**/*.{ts,tsx}`), então
// a projeção `[&_p]:` abaixo é escrita por extenso em vez de computada a partir de DOC — um nome de
// classe montado em runtime (`"[&_p]:" + x`) nunca seria gerado na folha de estilo.

/** Block-level classes — for elements the renderer owns (Markdown's own h2/p/blockquote/…). */
export const DOC = {
  /** o título do documento (um `# h1`) */
  title: "text-[30px] font-bold leading-[1.2] tracking-[-0.015em] sm:text-[40px]",
  /** uma seção (`## …`, o rótulo de um `section`, e todo título de widget — ver DOC_SECTION) */
  h1: "text-[24px] font-semibold leading-[1.3] tracking-[-0.01em] sm:text-[30px]",
  h2: "text-[20px] font-semibold leading-[1.3] sm:text-[24px]",
  h3: "text-[17px] font-semibold leading-[1.4] sm:text-[20px]",
  body: "text-[16px] leading-[1.6]",
  /** o parágrafo de abertura de um documento (o enunciado de uma ideia) — um degrau acima do corpo */
  lead: "text-[17.5px] leading-[1.55]",
  /** uma citação CURTA (pull-quote de um bloco `quote` do IR) — itálico, como no Notion */
  quote: "text-[16px] italic leading-[1.6]",
  /**
   * Um `>` de markdown, que nesta base é quase sempre um CALLOUT de contexto com vários blocos (o
   * bloco estratégico do card: posicionamento + resultado-alvo + métrica) — e é a ÚNICA caixa que
   * sobrou por desenho: um destaque que o autor pediu, a exceção que confirma o texto puro.
   */
  callout: "text-[15px] leading-[1.6]",
  code: "font-mono text-[13px] leading-relaxed",
  /** cabeçalho de tabela — negrito, do tamanho da célula. Caixa-alta é etiqueta de formulário. */
  tableHead: "text-[13.5px] font-semibold",
  tableCell: "text-[14px] leading-[1.5]",
} as const;

/**
 * O título de seção de um WIDGET de doc (Bloqueios · Histórico · Trajeto · Jornada · Telas). Mesmo
 * nível — e mesmo ritmo — de um `##` na prosa ao redor, para que a trilha do sumário (DocOutline
 * varre h1/h2/h3 no DOM renderizado) os liste como irmãos e eles PAREÇAM irmãos.
 */
export const DOC_SECTION = `mb-2 mt-10 ${DOC.h1} text-fg`;

/**
 * A mesma escala projetada na forma `[&_p]:…` que `InlineMd` exige: <Markdown> sempre embrulha o
 * texto num bloco `<div><p>…</p></div>`, e o DocRead achata isso para uma corrida inline cujo
 * tamanho/peso/cor QUEM CHAMA define (`.wrapper p` vence uma utility solta no elemento — ver o
 * cabeçalho do DocRead).
 */
export const DOC_INLINE = {
  title:
    "[&_p]:text-[30px] [&_p]:font-bold [&_p]:leading-[1.2] [&_p]:tracking-[-0.015em] [&_p]:text-fg sm:[&_p]:text-[40px]",
  h1: "[&_p]:text-[24px] [&_p]:font-semibold [&_p]:leading-[1.3] [&_p]:tracking-[-0.01em] [&_p]:text-fg sm:[&_p]:text-[30px]",
  h2: "[&_p]:text-[20px] [&_p]:font-semibold [&_p]:leading-[1.3] [&_p]:text-fg sm:[&_p]:text-[24px]",
  h3: "[&_p]:text-[17px] [&_p]:font-semibold [&_p]:leading-[1.4] [&_p]:text-fg sm:[&_p]:text-[20px]",
  body: "[&_p]:text-[16px] [&_p]:leading-[1.6] [&_p]:text-fg",
  /** o parágrafo de abertura (corpo de um `section` hero) */
  lead: "[&_p]:text-[17.5px] [&_p]:leading-[1.55] [&_p]:text-fg",
  /** a checked todo — same body scale, struck through */
  bodyDone: "[&_p]:text-[16px] [&_p]:leading-[1.6] [&_p]:text-fg-subtle [&_p]:line-through",
  quote: "[&_p]:text-[16px] [&_p]:italic [&_p]:leading-[1.6] [&_p]:text-fg-muted",
  toggle: "[&_p]:text-[16px] [&_p]:font-medium [&_p]:text-fg",
  tableHead: "[&_p]:text-[13.5px] [&_p]:font-semibold [&_p]:text-fg",
  tableCell: "[&_p]:text-[14px] [&_p]:leading-[1.5] [&_p]:text-fg",
} as const;
