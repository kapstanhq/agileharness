// "Alguém está TRABALHANDO nesta árvore agora?" — a segunda perna da prova de vida de uma sessão.
//
// O INCIDENTE (2026-07-27). Uma sessão interativa abriu o worktree às 03:58 e passou horas editando,
// buildando e rodando Playwright. Nada disso toca no MCP — e o `heartbeatAt` de uma sessão só avança
// quando ela CHAMA UMA TOOL (ou, para sessões com tmux, quando o `reconcileFleet` vê o painel vivo).
// Passadas as 6h de TTL a frota a declarou morta, a varredura liberou a pasta com
// `git worktree remove --force`, e 14 arquivos editados e não commitados deixaram de existir — sem
// commit, não há objeto no git: `fsck --dangling` não tem o que achar.
//
// O carimbo mediu a coisa ERRADA. `heartbeatAt` mede "conversou com o serviço"; o que autoriza uma
// remoção destrutiva é "ninguém está mexendo aqui". Para um agente headless as duas coincidem (ele vive
// chamando tools); para uma sessão interativa longa, não — e é justamente ela que acumula o trabalho
// mais caro de refazer.
//
// A MEDIDA CERTA, então, é o próprio trabalho: os arquivos SUJOS da árvore e quando foram tocados pela
// última vez. Isso tem três propriedades que o heartbeat não tem:
//   1. é PROVA DIRETA — mtime de arquivo não depende de ninguém lembrar de carimbar nada;
//   2. é AUTO-LIMITADA — árvore limpa não tem o que perder, então nem se pergunta (o heartbeat decide);
//   3. é BARATA — só roda para sessões que o registro JÁ considera mortas (raro), e sai no PRIMEIRO
//      arquivo recente que encontra (curto-circuito), quase sempre depois de um único `stat`.
//
// Módulo próprio (e não dentro de `session-liveness.ts`) porque aquele é SÍNCRONO e sem `exec` por
// contrato — ele é lido no caminho de baixo nível do teardown. Aqui há git e fs, e o teste alcança as
// duas partes: o parser é puro, a sonda recebe `exec`/`stat` injetados.

import { stat } from "node:fs/promises";

/** Quantas entradas de status vale a pena examinar. Uma árvore com mais mudanças que isto está VIVA de
 *  qualquer jeito (ou é um despejo de arquivos) — em ambos os casos, mais `stat` não muda a resposta. */
const MAX_ENTRIES = 2000;

/**
 * Os CAMINHOS de `git status --porcelain -z` (v1). Puro.
 *
 * O `-z` existe para não ter de desfazer o quoting do git (`core.quotepath` escapa acento e espaço):
 * com ele cada entrada é `XY <caminho>\0` literal. Renomeação/cópia emite DUAS entradas — a segunda é
 * o caminho de ORIGEM, que não existe mais no disco; pulá-la evita um `stat` garantidamente ENOENT.
 */
export function parsePorcelainZPaths(stdout: string, max = MAX_ENTRIES): string[] {
  const parts = stdout.split("\0");
  const out: string[] = [];
  for (let i = 0; i < parts.length && out.length < max; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue; // "XY " + ao menos 1 char de caminho
    const xy = entry.slice(0, 2);
    out.push(entry.slice(3));
    if (xy[0] === "R" || xy[0] === "C") i++; // a próxima parte é a origem do rename/copy
  }
  return out;
}

export interface ActivityDeps {
  exec: (cmd: string, opts: { cwd: string; timeout: number }) => Promise<{ stdout: string; stderr: string }>;
  /** mtime em ms de um caminho; null quando ele não existe / não dá para ler. */
  mtimeMs?: (p: string) => Promise<number | null>;
  now?: () => number;
}

/** Teto do probe. `git status` neste monorepo custa ~1s; 20s é folga absurda E limita o pior caso da
 *  varredura (que roda este probe uma vez por sessão dada como morta). */
const EXEC_TIMEOUT_MS = 20_000;

async function defaultMtimeMs(p: string): Promise<number | null> {
  try {
    return (await stat(p)).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Algum arquivo SUJO desta árvore foi tocado nos últimos `windowMs`?
 *
 * FAIL-CLOSED por desenho: se o `git status` não puder ser lido (árvore corrompida, git ausente,
 * timeout), a resposta é **true** — "não sei" nunca pode autorizar a remoção da árvore de alguém. O
 * custo de errar para este lado é uma pasta vazada, que a doutrina deste subsistema já declara barata
 * (node_modules são links); o custo de errar para o outro é o incidente que este módulo existe para
 * impedir.
 *
 * Árvore LIMPA devolve false de propósito: não há trabalho fora do git para proteger, e quem decide
 * ali é o heartbeat (uma sessão que commitou tudo e sumiu é exatamente o lixo que o varredor colhe —
 * e o branch dela, com commits, é preservado pelo teardown).
 */
export async function worktreeTouchedWithin(
  deps: ActivityDeps,
  worktreePath: string,
  windowMs: number,
): Promise<boolean> {
  const now = (deps.now ?? Date.now)();
  const mtimeMs = deps.mtimeMs ?? defaultMtimeMs;
  let stdout: string;
  try {
    // `-uall` lista arquivo a arquivo (em vez da pasta) — mais preciso para mtime e igualmente barato:
    // o git já poda diretórios ignorados (node_modules, .next) na varredura.
    ({ stdout } = await deps.exec(`git status --porcelain -z -uall`, {
      cwd: worktreePath,
      timeout: EXEC_TIMEOUT_MS,
    }));
  } catch {
    return true; // não deu para provar que está parada ⇒ trate como VIVA
  }
  const paths = parsePorcelainZPaths(stdout);
  if (!paths.length) return false; // árvore limpa — nada fora do git para proteger
  const cutoff = now - windowMs;
  for (const rel of paths) {
    // CURTO-CIRCUITO: o primeiro arquivo recente já responde a pergunta. Na prática isso é 1 `stat`,
    // porque quem está editando acabou de salvar alguma coisa.
    const m = await mtimeMs(`${worktreePath}/${rel}`);
    if (m != null && m > cutoff) return true;
  }
  return false;
}
