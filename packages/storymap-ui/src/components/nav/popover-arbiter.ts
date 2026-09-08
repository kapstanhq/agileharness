// UM painel por vez na barra de topo — a invariante, isolada do React para poder ser testada.
//
// A barra tem N gatilhos de hover INDEPENDENTES (os crumbs, os medidores, o Jido) e mais o estado
// COMPARTILHADO dos blocos (BlockNav). Cada um sabia fechar a si mesmo quando o ponteiro o deixava,
// e entre vizinhos isso bastava — mas não entre o Jido e um bloco: o `onPointerLeave` que fecha o
// painel de bloco mora no CONTÊINER do BlockNav e o Jido é FILHO dele, então atravessar do bloco
// para o mascote nunca "sai" do contêiner. Resultado: o painel do bloco ficava aberto e o balão do
// Jido abria por cima — dois painéis sobrepostos, nenhum dos dois legível.
//
// Consertar aquele par com mais um `onPointerEnter` deixaria a invariante espalhada por N handlers,
// e a próxima vizinhança nova repetiria o bug. Então ela é explícita e mora AQUI: abrir qualquer
// painel da barra fecha o que estava aberto.
//
// Estado de MÓDULO, não contexto: é uma invariante da barra inteira, não um dado que flui pela
// árvore — e assim um item novo herda o comportamento só por usar as primitivas da barra. Só um
// painel pode estar aberto por vez em toda a aplicação, então uma única célula basta.

/** O "fecha" do painel aberto no momento, ou `null` se nenhum está. */
let openNavPopover: (() => void) | null = null;

/**
 * Toma a vez para ESTE painel, fechando o que estava aberto.
 *
 * `close` precisa ter identidade ESTÁVEL entre renders — é a chave do registry. Uma closure nova a
 * cada render jamais casaria no {@link releaseNavPopover} e o registry acumularia fantasmas.
 *
 * Re-tomar a vez sendo já o dono é NO-OP (nunca fecha a si mesmo): é o caso de atravessar de um
 * bloco para outro, em que o painel só troca de conteúdo e o dono do estado continua o mesmo.
 */
export function claimNavPopover(close: () => void): void {
  if (openNavPopover && openNavPopover !== close) openNavPopover();
  openNavPopover = close;
}

/**
 * Devolve a vez ao sair de cena (fechar ou desmontar).
 *
 * Só limpa se o registry ainda aponta para VOCÊ. Sem essa checagem, o painel que acabou de ser
 * SUBSTITUÍDO apagaria o registro do sucessor ao processar o próprio fechamento — e o painel
 * seguinte a abrir não teria a quem fechar, ressuscitando exatamente o bug dos dois sobrepostos.
 */
export function releaseNavPopover(close: () => void): void {
  if (openNavPopover === close) openNavPopover = null;
}

/** Há algum painel da barra aberto? Existe para o teste afirmar sobre o estado; a UI não consulta. */
export function hasOpenNavPopover(): boolean {
  return openNavPopover !== null;
}
