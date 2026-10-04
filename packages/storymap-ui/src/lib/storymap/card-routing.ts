// A QUE BOARD UM CARD PERTENCE, pelos arquivos que ele toca. PURA.
//
// Um card de conserto nascido de outro card (a auditoria técnica, a prova de deploy, o aviso da revisão) não deve herdar
// o board do card de ORIGEM: um conserto que só toca arquivos de outro board pertence a ele. O board de um card é
// decidido pelo que ele MEXE: o board cujo `package` cobre os
// arquivos; depois os caminhos fora de pacote que um board declara possuir (`ownsPaths`); por último os pacotes
// compartilhados que um board toca (`sharedPackages` — tocar não é possuir, então pesa menos).
//
// Sem arquivos, ou sem um vencedor claro, fica no board de origem e diz por quê: errar para o lado de onde o pedido
// nasceu é o reversível (dá para mudar o card de board depois, card-transfer.ts).

import type { BoardConfig } from "./types";

/** O que um board declara sobre os arquivos que são dele. */
export type BoardFootprint = Pick<BoardConfig, "id" | "name" | "package" | "sharedPackages" | "ownsPaths">;

/** O veredito: o board escolhido e por quê (para o card e para o log). */
export interface BoardForFiles {
  board: string;
  /** true quando a escolha veio dos arquivos; false quando ficou no de origem por falta de prova. */
  routed: boolean;
  reason: string;
}

/** Peso de cada tipo de cobertura: possuir (pacote ou caminho declarado) vale mais do que tocar (compartilhado). */
const OWN_WEIGHT = 3;
const SHARED_WEIGHT = 1;

/** Normaliza um caminho relativo à raiz: sem `./`, sem barra inicial, com `/`. */
function norm(p: string): string {
  return p.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

/** O prefixo de diretório (com barra final) de um pacote/caminho declarado — `packages/a` cobre `packages/a/x`, não `packages/ab`. */
function asDirPrefix(p: string): string {
  const n = norm(p);
  return n.endsWith("/") ? n : `${n}/`;
}

/** O arquivo está sob o prefixo declarado? Um caminho declarado sem barra final também casa o próprio arquivo (`tarefas.toml`). */
function covers(declared: string, file: string): boolean {
  const n = norm(declared);
  if (!n) return false;
  return file === n || file.startsWith(asDirPrefix(n));
}

/**
 * O board dos `files`, entre `boards`. Cada arquivo dá pontos ao board que o possui (pacote ou `ownsPaths`) e, menos, a
 * quem o compartilha; vence o maior total. Empate com o de origem ⇒ o de origem; empate entre outros ⇒ o de origem, com o
 * motivo «ambíguo». Sem arquivos ou sem cobertura ⇒ o de origem. PURA.
 */
export function boardForFiles(files: readonly string[], boards: readonly BoardFootprint[], origin: string): BoardForFiles {
  const list = [...new Set(files.map(norm).filter(Boolean))];
  if (!list.length) return { board: origin, routed: false, reason: "sem arquivos para decidir — fica no board de origem" };
  const score = new Map<string, number>();
  let covered = 0;
  for (const file of list) {
    let hit = false;
    for (const b of boards) {
      const owns = [b.package, ...(b.ownsPaths ?? [])].some((p) => !!p && covers(p, file));
      const shares = !owns && (b.sharedPackages ?? []).some((p) => covers(p, file));
      if (owns || shares) {
        hit = true;
        score.set(b.id, (score.get(b.id) ?? 0) + (owns ? OWN_WEIGHT : SHARED_WEIGHT));
      }
    }
    if (hit) covered++;
  }
  if (!score.size) return { board: origin, routed: false, reason: "nenhum board declara os arquivos tocados — fica no board de origem" };
  const best = Math.max(...score.values());
  const leaders = [...score.entries()].filter(([, s]) => s === best).map(([id]) => id);
  if (leaders.includes(origin)) {
    return { board: origin, routed: leaders.length === 1, reason: `os arquivos são do board de origem (${covered}/${list.length} cobertos)` };
  }
  if (leaders.length > 1) return { board: origin, routed: false, reason: `os arquivos se dividem entre ${leaders.join(", ")} — fica no board de origem` };
  const name = boards.find((b) => b.id === leaders[0])?.name ?? leaders[0];
  return { board: leaders[0], routed: true, reason: `os arquivos tocados são do board «${name}» (${covered}/${list.length} cobertos)` };
}
