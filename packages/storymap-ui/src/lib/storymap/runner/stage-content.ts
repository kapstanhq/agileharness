// O QUE A STAGE TEM DE MAIS NOVO QUE A MAIN — por CONTEÚDO, arquivo a arquivo, no escopo de um board.
//
// Duas perguntas que tinham de ter a MESMA resposta e não tinham: «quantas entregas ainda não estão no ar?» (a Esteira
// contava commits do stage fora do histórico da main — mas a promoção RE-COMMITA o delta, então commit nenhum do stage
// vira ancestral da main, e um stage ATRÁS da main num arquivo do escopo aparecia como entrega pendente) e «o que o
// Publicar leva?» (a promoção). A régua aqui é a do conteúdo:
//
//   um arquivo está pendente quando (1) a stage o mudou desde a base da promoção, (2) ele difere entre main e stage e
//   (3) o conteúdo que a stage tem dele NUNCA esteve na main desde o ancestral comum (merge-base) — se esteve, a main já
//   teve exatamente aquilo e andou depois: o mais novo é o da MAIN (a stage está atrás), e publicar o da stage reverteria.
//
// A (3) é o que fecha o caso que o 3-way sozinho não fecha: a main que DESFEZ uma mudança já publicada (o conteúdo da
// stage reaparece «limpo» num merge contra uma base velha). PURO sobre o `run` injetado (o git de quem chama).

/** Roda `git <args>` e devolve o stdout, ou null quando o comando falhou. */
export type GitStdout = (args: string) => Promise<string | null>;

const q = (s: string): string => JSON.stringify(s);
const lines = (s: string | null): string[] => (s ?? "").split("\n").map((l) => l.trim()).filter(Boolean);

/** O «blob» de um arquivo apagado nas linhas `--raw` do git. */
const ZERO_BLOB = "0".repeat(40);

/** As linhas de `ls-tree -r` (`<modo> blob <sha>\t<caminho>`) como `caminho → sha`. PURA. */
export function treeBlobs(out: string | null): Map<string, string> {
  const map = new Map<string, string>();
  for (const l of lines(out)) {
    const tab = l.indexOf("\t");
    const sha = tab > 0 ? l.slice(0, tab).split(/\s+/)[2] : undefined;
    if (sha) map.set(l.slice(tab + 1), sha);
  }
  return map;
}

/** Os pares `caminho\0blob` de TODA linha `--raw` (um log traz várias por arquivo). PURA. */
function rawPairs(raw: string | null): Set<string> {
  const out = new Set<string>();
  for (const l of lines(raw)) {
    const tab = l.indexOf("\t");
    if (!l.startsWith(":") || tab < 0) continue;
    const blob = l.slice(0, tab).split(/\s+/)[3];
    if (blob) out.add(`${l.slice(tab + 1)}\0${blob}`);
  }
  return out;
}

/** Acima disto o pathspec vira o escopo inteiro (a linha de comando tem limite) — só a precisão do filtro (3) cai. */
const MAX_FILE_PATHSPEC = 400;

/**
 * Os arquivos do escopo cujo conteúdo na `stage` é MAIS NOVO que o da `live` (ver o topo). `null` = o git não respondeu
 * às perguntas (1)/(2) — o chamador decide (a contagem cai no «não sei», a promoção no caminho de sempre). Se só a (3)
 * falhar, devolve o conjunto de (1)∩(2): a promoção segue protegida pelo 3-way, como antes.
 */
export async function stageContentAhead(
  run: GitStdout,
  opts: { live: string; stage: string; base: string; pathspec: readonly string[] },
): Promise<string[] | null> {
  const spec = opts.pathspec.length ? ` -- ${opts.pathspec.map(q).join(" ")}` : "";
  const [divergentRaw, addedRaw] = await Promise.all([
    run(`diff --name-only --no-renames ${q(opts.live)} ${q(opts.stage)}${spec}`),
    run(`diff --name-only --no-renames ${q(opts.base)}..${q(opts.stage)}${spec}`),
  ]);
  if (divergentRaw === null || addedRaw === null) return null;
  const added = new Set(lines(addedRaw));
  const candidates = lines(divergentRaw).filter((f) => added.has(f));
  if (candidates.length === 0) return [];
  const mb = lines(await run(`merge-base ${q(opts.live)} ${q(opts.stage)}`))[0];
  if (!mb) return candidates;
  const fileSpec = candidates.length <= MAX_FILE_PATHSPEC ? ` -- ${candidates.map(q).join(" ")}` : spec;
  // o conteúdo da stage de cada candidato, e o que a main TEVE dele desde o ancestral comum: o do ancestral e o de cada
  // commit depois dele
  const [inStage, atBase, since] = await Promise.all([
    run(`ls-tree -r ${q(opts.stage)}${fileSpec}`),
    run(`ls-tree -r ${q(mb)}${fileSpec}`),
    run(`log --raw --no-renames --no-abbrev --format= ${q(mb)}..${q(opts.live)}${fileSpec}`),
  ]);
  if (inStage === null || atBase === null || since === null) return candidates;
  const stageBlob = treeBlobs(inStage);
  const mainHad = rawPairs(since);
  for (const [f, sha] of treeBlobs(atBase)) mainHad.add(`${f}\0${sha}`);
  // a stage que APAGOU o arquivo tem o blob zero: pendente, salvo se a main também o apagou desde o ancestral
  return candidates.filter((f) => !mainHad.has(`${f}\0${stageBlob.get(f) ?? ZERO_BLOB}`));
}
