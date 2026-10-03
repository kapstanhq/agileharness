// OS COMANDOS DE BARRA do composer — a via de TECLADO para o que hoje só existe atrás de um menu.
//
// O núcleo aqui é PURO e não conhece comando nenhum: ele só sabe responder três perguntas sobre o texto que
// está no campo — "a paleta está aberta?", "quais entradas casam?", "isto que ele digitou É um comando?".
// QUEM são os comandos é decisão do host (o painel do Jido registra os três do Claude Code: clear, compact,
// context); adicionar um é adicionar UMA entrada na lista dele, sem tocar neste arquivo nem na paleta.
//
// Duas decisões que valem o comentário:
//
//  1. A BARRA SÓ VALE NO COMEÇO, e só até o primeiro espaço. `/clear` abre a paleta; `e/ou`, `http://x` ou
//     "explica o `/compact`" são texto comum. Sem essa regra, todo caminho de arquivo que o operador colasse
//     viraria um menu piscando no meio da conversa.
//  2. COMANDO DESCONHECIDO NÃO É ERRO. `/xyz` simplesmente não casa com nada: a paleta some e o texto segue
//     como mensagem normal. Um chat que recusa a sua frase porque ela começa com barra é um chat que trata o
//     operador como um parser.

/** Uma entrada do menu. O host define a lista; este módulo só a filtra. */
export interface SlashCommand {
  /** o nome COMO SE DIGITA, sem a barra (`clear`, `compact`, `context`). */
  name: string;
  /** a linha de descrição na paleta — o que ele faz, em uma frase. */
  hint: string;
  /**
   * Pode rodar com um turno EM VOO? Default false: mexer no contexto (limpar/compactar) no meio de uma
   * resposta é como puxar a toalha da mesa posta. Leitura pura (`/context`) marca true.
   */
  whileBusy?: boolean;
}

/** Só letras/números/hífen — o que um nome de comando pode ter (e o que decide onde a consulta termina). */
const NAME_RE = /^[a-z0-9-]*$/;

/**
 * A CONSULTA ativa do campo, ou null quando a paleta não deve estar aberta.
 *
 * `"/"` → `""` (mostra tudo). `"/co"` → `"co"`. Qualquer coisa antes da barra, um espaço depois dela, ou um
 * caractere que não cabe num nome ⇒ null (é texto, não comando). Pura.
 */
export function slashQuery(text: string): string | null {
  if (!text.startsWith("/")) return null;
  const q = text.slice(1).toLowerCase();
  return NAME_RE.test(q) ? q : null;
}

/** As entradas que casam com a consulta (prefixo, na ordem do registro — previsível, sem ranking mágico). */
export function filterCommands(commands: readonly SlashCommand[], query: string): SlashCommand[] {
  const q = query.trim().toLowerCase();
  return commands.filter((c) => c.name.startsWith(q));
}

/**
 * O texto do campo é EXATAMENTE um comando (tolerando espaços em volta e caixa)? É o CINTO do envio: sem
 * isto, um `/clear ` com espaço sobrando fecharia a paleta e seria despachado ao modelo como uma mensagem
 * — o operador veria o Jido respondendo "não entendi /clear" em vez de a conversa ser limpa. Pura.
 */
export function exactCommand(commands: readonly SlashCommand[], text: string): SlashCommand | null {
  const t = text.trim().toLowerCase();
  if (!t.startsWith("/")) return null;
  const name = t.slice(1);
  return commands.find((c) => c.name === name) ?? null;
}

/** O texto que o campo passa a ter ao COMPLETAR uma entrada (o Tab da paleta). Pura. */
export function completionFor(command: SlashCommand): string {
  return `/${command.name}`;
}
