// As CHAVES DE GOVERNANÇA do board.yaml — o que só o operador decide e que, por isso, o merge train nunca aceita de um
// worktree. Hoje: `organizeOnly` (o board só de organização). Um run (ou uma sessão) que altera essa chave no board.yaml
// do seu worktree tem o resto da mudança aterrissado normalmente, mas o valor da chave volta ao que está vivo em main.
// PURO: recebe textos, devolve o texto corrigido (ou null quando não há nada a corrigir).

import { parseYamlMap } from "@/lib/storymap/frontmatter";

/** O caminho de um board.yaml (relativo ao repositório ou absoluto). */
export const BOARD_YAML_RE = /(^|\/)boards\/[^/]+\/board\.yaml$/;

/** O valor de `organizeOnly` como o parser do board o lê; null quando o texto não se parseia. */
export function organizeOnlyIn(raw: string): boolean | null {
  try {
    return parseYamlMap(raw).organizeOnly === true;
  } catch {
    return null;
  }
}

/** Uma linha de topo que declara a chave (qualquer grafia de chave que o YAML aceita: nua ou entre aspas). */
const KEY_LINE = /^(?:organizeOnly|"organizeOnly"|'organizeOnly')[ \t]*:.*(?:\r?\n|$)/gm;

/**
 * Devolve o board.yaml que aterrissou com `organizeOnly` de volta ao valor vivo de main (`liveText`), ou null quando o
 * valor já é o mesmo. Se a correção por linha não chegar ao valor esperado (uma forma exótica), devolve o texto vivo
 * inteiro: perder a parte não-governança dessa mudança é melhor que deixar um worktree mudar a chave.
 */
export function restoreGovernanceKeys(landedText: string, liveText: string | null): string | null {
  const live = liveText === null ? false : organizeOnlyIn(liveText);
  const landed = organizeOnlyIn(landedText);
  if (live === null) return null; // main ilegível: não é o train quem decide
  if (landed === live) return null;
  let next = landedText.replace(KEY_LINE, "");
  if (live) next = `${next.replace(/\s*$/, "")}\norganizeOnly: true\n`;
  if (organizeOnlyIn(next) === live) return next;
  return liveText ?? landedText.replace(KEY_LINE, "");
}
