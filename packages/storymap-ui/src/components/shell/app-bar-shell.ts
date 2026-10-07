// A CASCA da barra do topo (52px) — as medidas, num módulo NEUTRO (sem "use client").
//
// Quem mais precisa destas classes é o ESQUELETO da barra (server-side, para não custar JS): importar a
// string do `AppBar` (client, publica a própria altura) arrastaria o grafo dele para a tela de carregamento, e
// copiá-la à mão deixaria o esqueleto sair do lugar no dia em que a barra mudar. UMA definição, nenhum
// cliente a reboque.

/** O `<header>`: 52px fixos, borda de baixo suave, superfície — em TODA página (board e app-level). O vão entre os
 *  dois lados é curto (6px): o anel da cota já traz respiro dentro do alvo de toque de 40px. */
export const appBarShell =
  "relative z-40 flex h-[52px] shrink-0 items-center gap-1.5 border-b border-line-muted bg-surface px-4 md:gap-2.5";

/** Esquerda: a marca e a árvore (projeto / grupo). Encolhe e trunca antes da direita. */
// Em 390px cada pixel da esquerda vai para o NOME do projeto (o jeito de saber em que board se está): os vãos e as
// barras "/" ficam mais justos no celular e voltam ao desenho do md para cima. Com a pílula da Autonomia na direita
// (fase 4), o vão do celular é 2px: os 8px dos quatro vãos são o que deixa a 1ª palavra do board inteira em 390px.
export const appBarLeft = "flex min-w-0 flex-1 items-center gap-0.5 md:gap-1.5";

/** Direita: os sinais (Autonomia · cota · Inbox · engrenagem), colados à borda. */
export const appBarRight = "flex shrink-0 items-center justify-end gap-0.5 md:gap-1.5";

/** A barra "/" entre os degraus da árvore (#C2BFB8, 15px, traço fino). */
export const appBarSep = "shrink-0 select-none md:mx-0.5 text-[15px] font-light text-line-emphasis";

/** Um gatilho da árvore (projeto, grupo): rótulo 13px/600 + chevron, sem caixa em repouso. ≥40px no toque. */
export const appBarCrumb =
  "-ml-1.5 inline-flex h-10 min-w-0 items-center gap-1 rounded-md pl-1.5 pr-1 text-[13px] font-semibold text-fg-strong transition hover:bg-inset focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-fg md:h-7";

/** Um botão-ícone da direita (32px no desktop, 40px no toque). */
export const appBarIconButton =
  "relative inline-flex h-10 min-w-10 items-center justify-center gap-1.5 rounded-lg px-1.5 text-[13px] text-fg-muted transition hover:bg-inset hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-fg md:h-8 md:min-w-8";

/** O casco de um popover da barra (fundo, borda, sombra e raio do design). */
export const appBarPopover =
  "z-[70] rounded-[10px] border border-line bg-surface shadow-[0_14px_36px_rgba(15,15,15,0.16)]";
