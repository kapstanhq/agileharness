// A QUARENTENA do secret-scan nos commits de board-data (WP5-F1). PURA — zero IO; o git entra pelas portas.
//
// O commit de board-data era tudo-ou-nada: UM arquivo que o secret-scan recusava travava a versão do board INTEIRO. Em
// Num caso real o scan recusou dezenas de vezes um trecho de UM card (um identificador longo em crase que um agente escreveu no corpo),
// e tudo o que ficou fora do git nesse tempo foi exatamente o que o merge train apagou depois. Isolar só no flush não
// bastava: o card continuava sujo no disco, e TODO commit de fronteira o stageava de novo e falhava inteiro — o do engine
// antes de cortar o worktree de um run de código (nenhum run nascia), o settle de um run de board-data e o do train antes
// do merge-back. Por isso a quarentena mora no PONTO ÚNICO por onde todos passam (commitBoardDataScoped, worktree.ts):
// o arquivo recusado fica no disco e FORA do commit, e o resto é versionado. O scan NÃO afrouxa: o arquivo só entra no
// git quando o valor sai dele. Quem avisa no card (o achado) é o flush (board-data-flush.ts); quem não pode seguir sem o
// card é o run do PRÓPRIO card (engine, boundary-1 — ver {@link quarantinedOwnCard}).

import { BOARD_DATA_PATHSPEC } from "./config";

/** Quantas rodadas de «isolar e tentar de novo» antes de desistir (cada uma isola o que o scanner nomeou). */
const MAX_QUARANTINE_ROUNDS = 5;
/** A marca da recusa do scan no erro do commit de board-data (worktree.ts). Qualquer outra falha nunca isola nada. */
const SCAN_REFUSAL = "secret-scan bloqueou";

/** Um arquivo que o secret-scan recusou: o caminho e as linhas do scanner que o nomeiam (o valor já vem mascarado). */
export interface QuarantinedFile {
  path: string;
  detail: string;
}

/** A linha cita `p` como caminho inteiro? (`a.md` não casa dentro de `a.md.bak` nem de `xa.md`.) */
function namesPath(line: string, p: string): boolean {
  for (let i = line.indexOf(p); i >= 0; i = line.indexOf(p, i + 1)) {
    const before = i === 0 ? " " : line[i - 1];
    const after = line[i + p.length] ?? " ";
    if (/[\s"'(\[]/.test(before) && /[\s:"')\],]/.test(after)) return true;
  }
  return false;
}

/**
 * Os arquivos STAGED que a saída do scanner nomeia (`  ✗ [regra] <caminho>:<linha> → <prévia mascarada>`). Só o que
 * foi staged pode entrar em quarentena; um scanner que não nomeia arquivo (erro interno, formato desconhecido) não
 * produz suspeito nenhum — e o commit segue fail-closed como antes.
 */
export function secretScanSuspects(scannerOutput: string, staged: readonly string[]): QuarantinedFile[] {
  const lines = scannerOutput.split("\n");
  const out: QuarantinedFile[] = [];
  for (const p of staged) {
    const hits = lines.filter((l) => namesPath(l, p)).map((l) => l.trim());
    if (hits.length > 0) out.push({ path: p, detail: hits.join("\n") });
  }
  return out;
}

export interface QuarantineCommitDeps<R> {
  /** UMA tentativa do commit escopado do board, deixando `exclude` de fora; LANÇA quando o secret-scan recusa. */
  commit(exclude: readonly string[]): Promise<R>;
  /** os caminhos de board-data staged agora (o que a tentativa recusada deixou no índice). */
  stagedPaths(): Promise<string[]>;
}

/**
 * Commita o board pondo em quarentena o que o secret-scan recusar, uma rodada por vez: a recusa nomeia arquivos
 * staged ⇒ eles saem do índice e o commit é refeito sem eles. Qualquer outra falha (ou uma recusa que não nomeia um
 * arquivo do board) é relançada como antes — o scan nunca é contornado, só deixa de travar quem não tem culpa.
 */
export async function commitWithQuarantine<R>(deps: QuarantineCommitDeps<R>): Promise<{ result: R; quarantined: QuarantinedFile[] }> {
  const quarantined: QuarantinedFile[] = [];
  for (let round = 0; ; round++) {
    try {
      return { result: await deps.commit(quarantined.map((q) => q.path)), quarantined };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (round >= MAX_QUARANTINE_ROUNDS || !msg.includes(SCAN_REFUSAL)) throw err;
      const known = new Set(quarantined.map((q) => q.path));
      const suspects = secretScanSuspects(msg, await deps.stagedPaths()).filter((q) => !known.has(q.path));
      if (suspects.length === 0) throw err;
      quarantined.push(...suspects);
    }
  }
}

/**
 * O card de `board/cardId` ficou em quarentena neste commit? O run desse card não nasce de um HEAD sem a versão viva
 * dele (boundary-1 do engine); os runs dos OUTROS cards nascem normalmente.
 */
export function quarantinedOwnCard(
  quarantined: readonly QuarantinedFile[] | undefined,
  board: string,
  cardId: string,
): QuarantinedFile | undefined {
  const own = `${BOARD_DATA_PATHSPEC}${board}/cards/${cardId}.md`;
  return quarantined?.find((q) => q.path === own);
}
