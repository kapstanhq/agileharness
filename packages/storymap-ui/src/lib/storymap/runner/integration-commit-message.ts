// A MENSAGEM do commit que o merge train cria em main quando a metade de dados de uma entrada carrega arquivos
// FORA de `storymap/boards/` (hooks, scripts, configs da raiz — tudo o que não está sob um `codePrefixes`
// declarado). Antes, esse commit levava o rótulo `board: sessão <id>` / `board: <card> (run <id>)`, inventado
// pelo train: o autor da sessão perdia a própria mensagem e os trailers (Co-Authored-By, …), e um commit de
// CÓDIGO aparecia no histórico como dado de board. Agora: o rótulo `board:` só vale para o commit que contém SÓ
// dado de board; o resto carrega as mensagens dos commits da própria entrada. PURO — o chamador lê o log.

/** Separador de registro do `git log --format=%B%x1e` (RS, U+001E): nunca aparece numa mensagem de commit. */
export const COMMIT_LOG_RECORD_SEP = "\x1e";

/** O formato do `git log` que {@link parseCommitLog} entende. */
export const COMMIT_LOG_FORMAT = "%B%x1e";

/** As mensagens (corpo inteiro, `%B`) de um `git log --format=${COMMIT_LOG_FORMAT}`, na ordem dada. */
export function parseCommitLog(stdout: string): string[] {
  return stdout
    .split(COMMIT_LOG_RECORD_SEP)
    .map((m) => m.replace(/\r\n/g, "\n").trim())
    .filter(Boolean);
}

// `Chave: valor` (a forma de trailer do git) — uma linha que começa com espaço continua o trailer anterior.
const TRAILER_LINE = /^[A-Za-z0-9][A-Za-z0-9-]*:\s+\S/;

interface ParsedMessage {
  subject: string;
  body: string;
  trailers: string[];
}

function parseMessage(message: string): ParsedMessage {
  const lines = message.split("\n");
  const subject = (lines[0] ?? "").trim();
  const rest = lines.slice(1).join("\n").trim();
  if (!rest) return { subject, body: "", trailers: [] };
  const paragraphs = rest.split(/\n\s*\n/);
  const last = paragraphs[paragraphs.length - 1] ?? "";
  const lastLines = last.split("\n");
  const isTrailerBlock =
    lastLines.length > 0 &&
    TRAILER_LINE.test(lastLines[0] ?? "") &&
    lastLines.every((l) => TRAILER_LINE.test(l) || /^\s+\S/.test(l));
  if (!isTrailerBlock) return { subject, body: rest, trailers: [] };
  const trailers: string[] = [];
  for (const l of lastLines) {
    if (/^\s/.test(l) && trailers.length > 0) trailers[trailers.length - 1] += `\n${l}`;
    else trailers.push(l.trim());
  }
  return { subject, body: paragraphs.slice(0, -1).join("\n\n").trim(), trailers };
}

/**
 * Commits que o PRÓPRIO sistema rotula — dado de board (`board: estado vivo`, um flush no worktree da sessão) e
 * o commit de stage do train (`usm(<card|sessão>): código staged …`, que um rebase da sessão sobre `stage` pode
 * trazer para o branch dela) — não são a mensagem do autor: ficam de fora da composição.
 */
function isBoardLabel(subject: string): boolean {
  return /^board:/i.test(subject) || /^usm\([^)]*\): código staged/.test(subject);
}

/** As mensagens que são do AUTOR: sem os rótulos `board:` que o próprio sistema escreve. */
export function authoredMessages(messages: readonly string[]): string[] {
  return messages.filter((m) => {
    const subject = (m.split("\n")[0] ?? "").trim();
    return subject !== "" && !isBoardLabel(subject);
  });
}

/**
 * Compõe a mensagem de um commit de integração a partir das mensagens dos commits da entrada (mais antiga
 * primeiro), mais um trailer de PROVENIÊNCIA (`provenance`, ex.: `Merge-Train-Entry: sessão <id>`) — o id que antes
 * vivia no assunto inventado. Uma mensagem só ⇒ ela mesma, intacta (assunto, corpo e trailers). Várias ⇒ o
 * assunto da primeira, o corpo dela, um item `* <assunto>` (com o corpo) por commit seguinte, e TODOS os trailers
 * juntos no último parágrafo (deduplicados, na ordem em que apareceram) — onde o git os reconhece. Sem mensagem
 * do autor ⇒ `fallbackSubject`. Nunca devolve um assunto `board:` para quem chama com código.
 */
export function composeIntegrationMessage(
  messages: readonly string[],
  opts: { fallbackSubject: string; provenance?: string },
): string {
  const parsed = messages.map(parseMessage).filter((m) => m.subject && !isBoardLabel(m.subject));
  const trailers: string[] = [];
  const seen = new Set<string>();
  const addTrailer = (t: string) => {
    const key = t.toLowerCase().replace(/\s+/g, " ");
    if (seen.has(key)) return;
    seen.add(key);
    trailers.push(t);
  };
  let head: string;
  if (parsed.length === 0) {
    head = opts.fallbackSubject;
  } else {
    const [first, ...others] = parsed;
    const parts = [first!.subject];
    if (first!.body) parts.push(first!.body);
    for (const o of others) parts.push(o.body ? `* ${o.subject}\n\n${o.body}` : `* ${o.subject}`);
    head = parts.join("\n\n");
    for (const m of parsed) m.trailers.forEach(addTrailer);
  }
  if (opts.provenance) addTrailer(opts.provenance);
  return `${trailers.length > 0 ? `${head}\n\n${trailers.join("\n")}` : head}\n`;
}
