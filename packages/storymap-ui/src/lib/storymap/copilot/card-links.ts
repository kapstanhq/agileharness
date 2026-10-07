// Os IDs DE CARD que o Jido escreve na resposta («story-ex9001 está em Desenvolver») viram o TÍTULO do card, como
// link para a página dele — na TELA, só na hora de pintar (o texto da conversa guardado não muda). O dono lê
// «Buscar por título ou autor», não um id; e o id cru era o que a conversa mais mostrava de jargão.
//
// Puro e CLIENT-SAFE (zero import de node), testado em card-links.test.ts. A mesma régua de segurança do dejargon: só
// troca o que é CONHECIDO — um id que não é card deste board fica intacto (adivinhar seria pior que o id) — e nunca
// mexe em código: bloco cercado (```), trecho de código com outra coisa além do id, link markdown e URL ficam como
// estão. Um trecho de código que é SÓ o id (`story-ex9001`, o «chip» que o modelo costuma escrever) vira o link.

/** Um id de card no formato da ferramenta (`story-…`, minúsculas, números e hífens). */
const ID = "story-[a-z0-9]+(?:-[a-z0-9]+)*";

/** O id solto na prosa: não colado a uma palavra, a um caminho/URL (`/card/story-…`), ao texto de um link markdown
 *  (`[story-…]`) nem ao destino dele (`](story-…)`). */
const BARE = new RegExp(`(?<![\\w/#.\\[-]|\\]\\()(${ID})(?![\\w-]|\\])`, "g");

/** Os pedaços que NÃO se mexem: blocos cercados e trechos de código em linha. */
const CODE = /(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g;

/** O título como texto de link markdown: colchetes e barra invertida escapados (um título com «[» quebraria o link). */
function linkText(title: string): string {
  return title.replace(/[\\[\]]/g, (c) => `\\${c}`).replace(/\s+/g, " ").trim();
}

/**
 * Troca cada id de card CONHECIDO (`titles`: id → título) pelo link `[título](href)`. Ids desconhecidos, código,
 * links e URLs ficam intactos. PURA.
 */
export function linkCardIds(text: string, titles: ReadonlyMap<string, string>, href: (id: string) => string): string {
  if (!text || titles.size === 0 || !text.includes("story-")) return text;
  const link = (id: string) => {
    const title = titles.get(id);
    return title ? `[${linkText(title)}](${href(id)})` : null;
  };
  return text
    .split(CODE)
    .map((part, i) => {
      // `split` com grupo de captura: os índices ímpares são os pedaços de código
      if (i % 2 === 1) {
        const only = new RegExp(`^\`(${ID})\`$`).exec(part);
        return (only && link(only[1])) ?? part;
      }
      return part.replace(BARE, (whole, id: string) => link(id) ?? whole);
    })
    .join("");
}
