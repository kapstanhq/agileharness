// ONDE NASCE UM CARD DE CONSERTO AUTOMÁTICO — o board pelos ARQUIVOS que o conserto toca (card-routing.ts), não o board
// do card de origem. O conserto de um arquivo que outro board possui nasce lá, apontando por texto para a origem (um id
// de outro board não vale como vínculo); sem arquivos ou sem board claro, nasce na origem, como antes.

import { listBoards, readBoardConfig } from "@/lib/storymap/repo";
import { boardForFiles, type BoardForFiles, type BoardFootprint } from "@/lib/storymap/card-routing";

/** Os boards do alvo com o que cada um declara possuir. Tolerante: um board ilegível fica de fora. */
export async function boardFootprints(): Promise<BoardFootprint[]> {
  const out: BoardFootprint[] = [];
  for (const b of await listBoards().catch(() => [])) {
    const cfg = await readBoardConfig(b.id).catch(() => null);
    if (cfg) out.push({ id: cfg.id ?? b.id, name: cfg.name, package: cfg.package, sharedPackages: cfg.sharedPackages, ownsPaths: cfg.ownsPaths });
  }
  return out;
}

/** O board do conserto que toca `files`, nascido de um card de `origin`. Nunca lança (na dúvida, a origem). */
export async function fixCardBoard(origin: string, files: readonly string[]): Promise<BoardForFiles> {
  try {
    return boardForFiles(files, await boardFootprints(), origin);
  } catch {
    return { board: origin, routed: false, reason: "os boards não puderam ser lidos — fica no board de origem" };
  }
}

/** A linha do corpo que aponta para a origem quando o conserto nasce em OUTRO board. */
export function originLine(originBoard: string, cardId: string, title: string | undefined, routed: BoardForFiles): string[] {
  return [`- Nasceu do card ${cardId}${title ? ` — ${title}` : ""}, do board «${originBoard}».`, `- Por que este board: ${routed.reason}.`];
}
