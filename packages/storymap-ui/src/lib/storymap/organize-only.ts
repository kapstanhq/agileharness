// organize-only — o board SÓ DE ORGANIZAÇÃO.
//
// POR QUE EXISTE: o board da própria ferramenta não deve se desenvolver sozinho — o trabalho nela é feito por sessões
// independentes, e o board só serve para ler, escrever e mover cards. O `autorunDisabled` (desarmado) desliga só a
// cascata e o que pergunta ao portão com a configuração em mãos; sobravam atores que agem num board desarmado
// (copiloto, reconcile/settle, publicação, onEnter de um move, roteamento que manda card PARA ele, tick de saúde…).
//
// O CONTRATO: `organizeOnly: true` no board.yaml ⇒
//   · nada automático AGE no board (todo ator consulta `isOrganizeOnly`, direto ou pelo portão, que a lê);
//   · nada CHEGA sozinho (roteamento da triagem, consertos roteados, criação automática com `via` de sistema);
//   · agentes por MCP e o operador pela tela continuam lendo, escrevendo, movendo e transferindo cards.
// O portão (`resolveBoardGate`) responde «segurado» com a fonte `organize-only`, então quem já pergunta ao portão herda;
// quem não pergunta chama `isOrganizeOnly` / `organizeOnlyNow` aqui. A catraca organize-only.test.ts prova os dois.

import fs from "node:fs";
import path from "node:path";
import type { BoardConfig } from "./types";
import { boardsDir } from "./paths";
import { isOrganizeOnly } from "./organize-only-core";
import { parseYamlMap } from "./frontmatter";

export { ORGANIZE_ONLY_WHY, isOrganizeOnly } from "./organize-only-core";

/**
 * O modo como o PARSER do board o lê (o mesmo de repo.ts: `organizeOnly === true`) — nunca uma expressão regular de
 * linha, que discordaria do YAML (`True`, `"organizeOnly": true`, `!!bool true` ligam o modo para o parser).
 */
function organizeOnlyIn(raw: string): boolean {
  return parseYamlMap(raw).organizeOnly === true;
}

const CACHE_KEY = Symbol.for("agileharness.organizeOnly.cache");
type CacheRow = { file: string; sig: string; value: boolean };
const holder = globalThis as unknown as Record<symbol, Map<string, CacheRow> | undefined>;

/**
 * O modo lido do DISCO, síncrono e em cache pelo mtime — para quem pergunta ao portão sem a configuração em mãos
 * (o copiloto e o pump do engine passam `{}`). Nunca lança. Board sem board.yaml ⇒ false (não existe); board.yaml que
 * EXISTE mas não se lê ou não se parseia ⇒ true (fail-closed: na dúvida, nada roda sozinho nele).
 */
export function organizeOnlyNow(board: string): boolean {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(board)) return false;
  let file: string;
  try {
    file = path.join(boardsDir(), board, "board.yaml");
  } catch {
    return false;
  }
  const cache = (holder[CACHE_KEY] ??= new Map());
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return false; // sem board.yaml: o board não existe
  }
  const sig = `${st.mtimeMs}:${st.size}`;
  const hit = cache.get(board);
  if (hit && hit.file === file && hit.sig === sig) return hit.value;
  let value: boolean;
  try {
    value = organizeOnlyIn(fs.readFileSync(file, "utf8"));
  } catch {
    value = true; // existe mas não se lê/parseia: fail-closed
  }
  cache.set(board, { file, sig, value });
  return value;
}

/** O modo pela configuração quando ela veio, senão pelo disco. Nunca lança. */
export function organizeOnlyOf(board: string, config?: Pick<BoardConfig, "organizeOnly"> | null): boolean {
  return isOrganizeOnly(config) || organizeOnlyNow(board);
}
