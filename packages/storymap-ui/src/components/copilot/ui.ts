// A ESCALA do painel do Jido — a fonte ÚNICA de tamanho, cor, raio e espaçamento do chat.
//
// Por que existe: o painel tinha 5 tamanhos de texto (10/11/12/13/sm), 5 raios (md/lg/xl/2xl/full), 4 tamanhos
// de ícone e 6 combinações de padding, escolhidos ad hoc em 5 arquivos. Cada peça estava OK sozinha e o
// conjunto parecia montado por cinco pessoas diferentes. Aqui a escala é DECLARADA e importada: mexer num
// degrau muda o painel inteiro, e uma peça nova nasce alinhada sem ninguém precisar lembrar do número.
//
// Regra de cor: o texto usa só fg/fg-muted/fg-subtle; verde/âmbar/rosa aparecem SOMENTE em indicador de estado
// (o ponto, a barra) — nunca colorindo texto corrido. O âmbar (accent) é reservado ao que está VIVO agora.

/** TIPOGRAFIA — três degraus, e só. Não invente um quarto. */
export const TXT = {
  /** conteúdo: mensagens, campo de texto. */
  body: "text-[13px]",
  /** rótulos, botões, ações. */
  label: "text-[12px]",
  /** meta: tempo, tokens, custo, estado. */
  meta: "text-[11px]",
} as const;

/** ÍCONES — dois degraus: inline (junto de texto) e ação (clicável sozinho). */
export const ICON = {
  inline: "h-3.5 w-3.5 shrink-0",
  action: "h-4 w-4 shrink-0",
} as const;

/** A SARJETA horizontal do painel: TODA faixa (header, medidor, composer) usa a mesma. */
export const GUTTER = "px-4";

/** Faixa horizontal do painel (header/medidor/rodapé): sarjeta + respiro vertical padrão. */
export const BAND = "px-4 py-2.5";

/** Divisor entre faixas — uma linha só, nunca duas empilhadas. */
export const DIVIDER = "border-b border-line";

/** Ação secundária (fantasma). */
export const BTN_GHOST =
  "inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1 text-[12px] font-medium text-fg-subtle transition hover:bg-surface-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-40";

/** Ação primária (sólida — o "Enviar"). */
export const BTN_SOLID =
  "inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-fg px-3 py-1.5 text-[12px] font-semibold text-surface transition hover:bg-fg/85 disabled:cursor-not-allowed disabled:opacity-40";

/** Botão-ícone (fechar, engrenagem). */
export const BTN_ICON =
  "inline-flex shrink-0 items-center justify-center rounded-lg p-1.5 text-fg-subtle transition hover:bg-surface-hover hover:text-fg";

/**
 * FAIXA DE AVISO — a tarja fina no topo do painel ("turno em andamento", "ciclo autônomo rodando").
 * Some a tarja pintada inteira (`bg-indigo-50 text-indigo-700`): a superfície é o poço neutro do painel
 * e o texto é tinta comum; QUEM carrega o estado é o ponto de `DOT[tone]` — a mesma porta por onde
 * verde/âmbar/rosa entram em todo o resto do chat. Compõe com `DIVIDER`.
 */
export const NOTICE_BAND =
  "flex shrink-0 items-center gap-2 bg-inset px-4 py-1.5 text-[12px] leading-snug text-fg-muted";

/**
 * Chip/pill neutro (tool, anexo, contador) — a família do META: o que INFORMA.
 *
 * Sem borda, como todo o resto de dentro do painel (ver {@link SOFT} logo abaixo): num transcript com 4
 * tools, 4 retângulos contornados competiam com o texto que o operador está lendo. O que separa este chip
 * de um {@link QUICK_CHIP} (o que AGE) não é mais o contorno — é o tamanho e a tinta: 11px em `fg-subtle`
 * contra 12.5px em `fg-muted` num alvo de toque. Informação sussurra; ação tem corpo.
 */
export const CHIP =
  "inline-flex items-center gap-1.5 rounded-lg bg-fg/[0.05] px-2 py-1 text-[11px] leading-none text-fg-subtle";

/**
 * A SUPERFÍCIE MACIA — o preenchimento que substituiu a BORDA dentro do painel.
 *
 * O painel já é um componente com borda (o rail, a gaveta, o popover). Dentro dele havia mais bordas: cada
 * opção de escolha era um retângulo contornado, a saída aberta um retângulo tracejado, cada atalho uma
 * pílula contornada — retângulo dentro de retângulo dentro de retângulo. O olho perde a hierarquia: tudo
 * parece igualmente "uma caixa", e nada diz o que é agrupamento e o que é botão. Gemini, ChatGPT e Claude
 * resolveram do mesmo jeito e é o que fazemos aqui: DENTRO de uma superfície, o clicável se distingue por
 * PESO (um véu de tinta), não por contorno. Borda fica para separar SUPERFÍCIES, não elementos.
 *
 * É `fg` com alfa — e não `bg-inset` — de propósito: um véu da própria tinta funciona sobre QUALQUER
 * superfície (papel, poço, cartão) e nos DOIS temas, sem segunda paleta. No escuro, `inset` é mais ESCURO
 * que a superfície e `surface-hover` mais claro: um hover que atravessa a superfície, cavando e depois
 * levantando. O véu só fica um degrau mais forte.
 */
export const SOFT = "bg-fg/[0.05]";
export const SOFT_HOVER = "hover:bg-fg/[0.09]";

/**
 * LINHA DE ESCOLHA — uma opção que o agente ofereceu (`AskChoices`/`OptionChips`).
 *
 * Largura cheia e alvo generoso: ela carrega rótulo + a descrição do agente, e é tocada no celular. O
 * `items-start` mantém o marcador (só existe em `multi`) alinhado com a PRIMEIRA linha do rótulo quando a
 * descrição quebra em duas.
 */
export const CHOICE_ROW = `flex w-full items-start gap-2.5 rounded-xl ${SOFT} px-3 py-2.5 text-left transition ${SOFT_HOVER} disabled:cursor-not-allowed disabled:opacity-50`;

/** …a mesma linha MARCADA. Só existe em `multi` (no `single` um toque resolve e não há estado a mostrar). */
export const CHOICE_ROW_ON = "bg-accent/15 hover:bg-accent/20";

/**
 * RESPOSTA RÁPIDA — a pílula de atalho. Grande de propósito: ela é um ALVO (um toque envia aquele texto),
 * não uma etiqueta de status como o {@link CHIP}. Era do tamanho de um chip de tool, contornada igual, e a
 * diferença entre "isto informa" e "isto age" ficava só no cursor.
 */
export const QUICK_CHIP = `inline-flex max-w-full items-center gap-1.5 rounded-full ${SOFT} px-3.5 py-2 text-[12.5px] font-medium leading-none text-fg-muted transition ${SOFT_HOVER} hover:text-fg disabled:cursor-not-allowed disabled:opacity-50`;

/** Campo de texto. `resize-none` + teto: quem manda na altura é o conteúdo (o composer cresce sozinho). */
export const FIELD =
  "w-full resize-none overflow-y-auto rounded-lg border border-line bg-inset px-3 py-2 text-[13px] leading-relaxed text-fg outline-none transition placeholder:text-fg-subtle focus:border-accent focus:ring-2 focus:ring-accent/30";

/**
 * O CAMPO SEM CASCA — o mesmo texto, sem borda/fundo próprios, para viver DENTRO do {@link COMPOSER_BOX}.
 * Ele existe porque a caixa passou a ser a moldura de tudo (campo + ações), e um campo com borda dentro de
 * uma caixa com borda são duas molduras concêntricas. Aqui o foco acende a CAIXA, não o campo.
 */
export const FIELD_BARE =
  "w-full resize-none overflow-y-auto border-0 bg-transparent px-2.5 py-2 text-[13px] leading-relaxed text-fg outline-none ring-0 placeholder:text-fg-subtle focus:outline-none focus:ring-0";

/**
 * A CAIXA do composer — campo, anexos e ações numa peça só (o padrão de Claude/ChatGPT/Gemini). O que
 * antes eram dois objetos empilhados (um input com borda + uma fileira de botões soltos embaixo) vira UM
 * objeto que o operador reconhece como "onde eu falo": os comandos ficam visualmente DENTRO do input.
 */
export const COMPOSER_BOX =
  "rounded-[18px] border border-line bg-inset px-1.5 pb-1.5 pt-0.5 transition focus-within:border-accent/60 focus-within:ring-2 focus-within:ring-accent/15";

/**
 * O DEGRADÊ do topo do transcript — a conversa some por baixo da barra em vez de ser cortada por uma
 * régua. Fica sob a barra flutuante (que é opaca) e acompanha a superfície do painel.
 */
export const TOP_FADE = "pointer-events-none h-7 bg-gradient-to-b from-surface via-surface/85 to-transparent";

/**
 * O RESPIRO que o transcript reserva para a barra flutuante — e ele tem de cobrir o degradê INTEIRO,
 * não só a barra.
 *
 * O erro que isto conserta: o respiro era `pt-14` (56px) enquanto a barra + o {@link TOP_FADE} somam
 * ~66px (barra: 8 de topo + ~26 de conteúdo + 4 de base = 38; degradê: 28). A primeira linha da
 * primeira mensagem nascia DENTRO do degradê — no ponto onde ele ainda cobre ~70% da tinta — e ficava
 * lavada, encostada na barra. Era o defeito que o Operador via como "o texto do topo quase escondido".
 *
 * O degradê existe para apagar a transição de um texto que ESTÁ ROLANDO por baixo da barra; ele nunca
 * deveria pintar por cima do REPOUSO. Daí a régua: o respiro é a barra + o degradê + a folga do
 * primeiro parágrafo, e não a barra sozinha. Mexeu na altura da barra ou do degradê? Mexa aqui junto.
 */
export const TOP_BAR_CLEARANCE = "pt-[4.75rem]";

/** Bolha de mensagem (o canto "rabinho" muda por lado). */
export const BUBBLE = "inline-block max-w-[88%] rounded-2xl px-3 py-2 text-[13px] leading-snug text-fg";

/**
 * A PROSA do agente em LARGURA CHEIA — o corpo de uma resposta não é uma bolha.
 *
 * A bolha existe para dizer "isto é fala de alguém, e o alguém é o outro lado". Isso vale para o
 * OPERADOR, cujas mensagens são curtas e alternadas. A resposta do agente é a matéria da tela: tem
 * parágrafo, lista, tabela, bloco de código — e espremê-la em 88% de largura com um poço colorido é o
 * que fazia o painel parecer um mensageiro em vez de um documento vivo. Claude, ChatGPT e Gemini
 * chegaram todos ao mesmo lugar: humano em bolha, agente em texto.
 *
 * As classes aqui só ajustam o RESPIRO da escala compacta ao contexto de chat (primeiro/último bloco sem
 * margem) — a escala em si continua sendo a do `Markdown variant="compact"`, fonte única de tamanho.
 */
export const FLOW_PROSE =
  "w-full min-w-0 [&_p]:my-1.5 [&_ul]:my-1.5 [&_ol]:my-1.5 [&_pre]:my-2 [&_table]:my-2 [&>div>*:first-child]:mt-0 [&>div>*:last-child]:mb-0";

/** O TOM de um estado. É a ÚNICA porta por onde verde/âmbar/rosa entram no painel. */
export type Tone = "ok" | "warn" | "danger" | "neutral" | "accent";

/** Ponto de estado (o pisca-pisca de "vivo"). */
export const DOT: Record<Tone, string> = {
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  danger: "bg-rose-500",
  accent: "bg-accent",
  neutral: "bg-fg-subtle/40",
};

/**
 * Traço do ANEL de contexto (o medidor redondo do composer). É `stroke-*` e não `bg-*` porque o anel é SVG —
 * mesma paleta de DOT/BAR, outra propriedade. A barra de 3px sob o header (`ContextRail`) foi APOSENTADA: uma
 * linha atravessada no painel lia como divisória/progresso de carregamento, e o lugar de um medidor de sessão
 * é junto do composer, como Claude e ChatGPT fazem — ícone, não régua.
 */
export const RING: Record<Tone, string> = {
  ok: "stroke-emerald-500",
  warn: "stroke-amber-500",
  danger: "stroke-rose-500",
  accent: "stroke-accent",
  neutral: "stroke-fg-subtle/40",
};

/** Preenchimento de barra (usado no menu da sessão — a barrinha dos números exatos). */
export const BAR: Record<Tone, string> = {
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  danger: "bg-rose-500",
  accent: "bg-accent",
  neutral: "bg-fg-subtle/40",
};

/** Chip COLORIDO (só para estado — o chip da verdade do modo autônomo). */
export const CHIP_TONE: Record<Tone, string> = {
  ok: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  warn: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  danger: "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300",
  accent: "border-accent/40 bg-accent/10 text-accent",
  neutral: "border-line bg-surface text-fg-subtle",
};
