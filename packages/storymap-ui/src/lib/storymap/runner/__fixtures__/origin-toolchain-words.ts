// Os nomes de um ferramental de publicação ALHEIO que a ferramenta não pode carregar — em código, comentário, título de
// teste ou mensagem. Guardados só como sha256: a lista de proibidos não traz os nomes nem os deixa remontar. A varredura
// quebra cada linha em pares adjacentes de palavras unidas por `-` ou `/` e compara o hash de cada par. Só os testes usam.

import { createHash } from "node:crypto";

/** sha256 dos nomes de publicação proibidos (pares `a-b`). */
export const ORIGIN_TOOLCHAIN_HASHES: ReadonlySet<string> = new Set([
  "9b6550c53f7eb216f088605086d9f858f5be90bbdea7bd25cce21cf7c4a33d27",
  "4803826b4e2f347065bbbd65e704dad2fb43d783137468397cfc48b696073381",
  "55bf2a992ce07810cdbcce9a11398b150ff0ce171d3d436c2965dfa30ac18368",
]);

/** sha256 de um caminho de estado de orquestrador proibido como literal (par `a/b`). */
export const ORIGIN_STATE_PATH_HASHES: ReadonlySet<string> = new Set([
  "36e03688ecefeccc43a9d03e6834c286cd59c68c0d8433897947f8f965c1e1f6",
]);

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** Os pares adjacentes `a-b` / `a/b` de uma linha (minúsculos), na ordem em que aparecem. */
export function adjacentPairs(line: string): string[] {
  const out: string[] = [];
  for (const tok of line.toLowerCase().match(/[a-z0-9_]+(?:[-/][a-z0-9_]+)+/g) ?? []) {
    const parts = tok.split(/([-/])/);
    for (let i = 0; i + 2 < parts.length; i += 2) out.push(`${parts[i]}${parts[i + 1]}${parts[i + 2]}`);
  }
  return out;
}

/** A linha carrega um dos pares proibidos (comparado por hash)? */
export function hitsHashed(line: string, hashes: ReadonlySet<string>): boolean {
  return adjacentPairs(line).some((p) => hashes.has(sha(p)));
}
