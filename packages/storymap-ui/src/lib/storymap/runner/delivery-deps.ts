// O lado IMPURO da fronteira de publicação: git e config. Quem consome é o Inbox (`cockpit-collect`: «Publicar as N
// entregas») e o boot (`instrumentation`). A Esteira, que nasceu com este módulo, saiu na fase 3.
//
// Espelha a divisão de `fleet-view` / `fleet-deps`: as réguas ficam em `delivery-view` (puras, testáveis sem subir
// nada) e aqui mora só a leitura do mundo. Toda consulta é BEST-EFFORT — um campo vazio vence um item que explode
// porque um `git rev-parse` não respondeu.

import { releaseCodePrefixes } from "./release-scope";
import { stageContentAhead } from "./stage-content";
import { declaredCodePrefixes } from "./staging";
import { parseStagedLog, stagedTotalOf, STAGED_LOG_FORMAT, type BoardFrontier } from "./delivery-view";
import { loadRunnerConfig } from "./config";
import { isOrganizeOnly } from "@/lib/storymap/organize-only-core";
import type { ExecFn } from "./worktree";
import { findRepoRoot } from "@/lib/storymap/paths";
import { readBoardConfig } from "@/lib/storymap/repo";
import { mayRequestPublish, releaseModeOf } from "@/lib/storymap/release-policy";

/** Teto de commits listados por board — a raia mostra entregas, não o histórico do repositório. */
const MAX_STAGED = 30;
/** Acima disto a lista de entregas usa o escopo do board como pathspec (a linha de comando tem limite). */
const MAX_PENDING_PATHSPEC = 400;
const GIT_TIMEOUT_MS = 20_000;

const q = (s: string): string => JSON.stringify(s);

/** `git` no repo raiz, devolvendo stdout limpo — ou `null` quando o comando falha (nunca lança). */
async function git(exec: ExecFn, cmd: string): Promise<string | null> {
  try {
    const { stdout } = await exec(`git ${cmd}`, { cwd: findRepoRoot(), timeout: GIT_TIMEOUT_MS });
    return String(stdout).trim();
  } catch {
    return null;
  }
}

/**
 * A fronteira de UM board. A base do delta é a MESMA que a promoção usa (`refs/promoted/<board>`,
 * validada como ancestral do stage, senão o merge-base) — copiar a regra seria criar a segunda verdade
 * que o `release-scope` acabou de eliminar; aqui ela é relida do mesmo jeito, com a mesma condição.
 *
 * O escopo por caminho importa: sem ele a contagem incluiria o que OUTRO board deixou no stage
 * compartilhado, e o Inbox prometeria publicar algo que a promoção deste board não leva.
 *
 * É o número que decide publicar («Publicar as N entregas»), e a régua dele são os ARGUMENTOS do git (base,
 * pathspec, exclusão do que já está no ar) — o teste os cobra direto.
 */
export async function frontierOf(board: string, exec: ExecFn): Promise<BoardFrontier> {
  const cfg = loadRunnerConfig().autorun;
  // UMA leitura do board.yaml serve as duas coisas que precisam dele: a política de release e os
  // prefixos de código do escopo. Best-effort como o resto deste módulo — ilegível ⇒ default seguro
  // (`manual`) e escopo global, nunca uma página vazia.
  const boardConfig = await readBoardConfig(board).catch(() => null);
  // A política vem do BOARD (a lista `publishQueue.boards` foi aposentada); do settings sobra só o
  // kill-switch global do mecanismo.
  const releaseMode = releaseModeOf(boardConfig);
  const canPublish = mayRequestPublish({
    queueEnabled: !!cfg.publishQueue?.enabled,
    stagingEnabled: !!cfg.staging?.enabled,
  });
  const stageBranch = cfg.staging?.branch;
  const empty: BoardFrontier = {
    board,
    releaseMode,
    canPublish,
    ...(isOrganizeOnly(boardConfig) ? { organizeOnly: true } : {}),
    liveSha: null,
    liveAt: null,
    stageSha: null,
    staged: [],
    stagedTotal: 0,
  };
  if (!cfg.staging?.enabled || !stageBranch) return empty;

  const [liveLine, stageSha] = await Promise.all([
    git(exec, `log -1 --format=${q("%H %cI")} HEAD`),
    git(exec, `rev-parse --verify --quiet ${q(`${stageBranch}^{commit}`)}`),
  ]);
  const [liveSha = null, liveAt = null] = (liveLine ?? "").split(" ");
  if (!stageSha) return { ...empty, liveSha, liveAt };

  // A base: a fronteira do board quando ela existe E é ancestral do stage; senão o merge-base.
  const promotedRef = `refs/promoted/${board}`;
  let base = "";
  const frontier = await git(exec, `rev-parse --verify --quiet ${q(promotedRef)}`);
  if (frontier) {
    const ok = await git(exec, `merge-base --is-ancestor ${q(frontier)} ${q(stageBranch)}`);
    if (ok !== null) base = frontier; // exit 0 ⇒ é ancestral
  }
  if (!base) base = (await git(exec, `merge-base HEAD ${q(stageBranch)}`)) || "";
  if (!base) return { ...empty, liveSha, liveAt, stageSha };

  // Indeclarado (`codePrefixes` ausente) ⇒ sem escopo global: um board COM `package` ainda tem o seu; um board sem
  // pacote não tem o que medir (a promoção também recusaria — `no-prefix` — e diz o que declarar).
  const prefixes = releaseCodePrefixes(boardConfig, declaredCodePrefixes(cfg.staging) ?? []);
  const pathspec = prefixes.length ? ` -- ${prefixes.map(q).join(" ")}` : "";
  // "ainda não no ar" é medido pela DIFERENÇA DE CONTEÚDO (stage-content.ts) — a MESMA régua que decide o que o «Publicar»
  // leva (release.ts): os arquivos do escopo que a stage mudou desde a base, que diferem da main e cujo conteúdo na stage
  // nunca esteve na main. Contar commits do stage fora do histórico da main mentia nos dois sentidos: a promoção
  // RE-COMMITA o delta (commit do stage nenhum vira ancestral da main, então o que já foi publicado continuava «pendente»),
  // e um stage ATRÁS da main num arquivo do escopo aparecia como entrega a publicar — que, publicada, reverteria a main.
  // As ENTREGAS (a lista e o número) são os commits do stage que tocam esses arquivos; sem arquivo pendente, nenhuma.
  const live = liveSha || "HEAD";
  const pending = await stageContentAhead((args) => git(exec, args), { live, stage: stageBranch, base, pathspec: prefixes });
  if (pending === null) return { ...empty, liveSha, liveAt, stageSha };
  if (pending.length === 0) return { ...empty, liveSha, liveAt, stageSha, pendingFiles: 0 };
  const notLive = liveSha ? ` --not ${q(liveSha)}` : "";
  const pendingSpec = pending.length <= MAX_PENDING_PATHSPEC ? ` -- ${pending.map(q).join(" ")}` : pathspec;
  // A LISTA é capada (a raia mostra entregas, não o histórico do repositório) mas a CONTAGEM não pode ser: acima do teto
  // ela reportaria o teto como se fosse o total — e este é o número que decide publicar.
  const [log, count] = await Promise.all([
    git(
      exec,
      `log --no-merges --max-count=${MAX_STAGED} --format=${q(STAGED_LOG_FORMAT)} ${q(base)}..${q(stageBranch)}${notLive}${pendingSpec}`,
    ),
    git(exec, `rev-list --no-merges --count ${q(base)}..${q(stageBranch)}${notLive}${pendingSpec}`),
  ]);
  const staged = log ? parseStagedLog(log) : [];
  return {
    board,
    releaseMode,
    canPublish,
    liveSha,
    liveAt,
    stageSha,
    staged,
    // conteúdo pendente sem commit que o carregue fora do ar (o commit já é ancestral do que está no ar): ainda é 1 entrega
    stagedTotal: Math.max(1, stagedTotalOf(count, staged.length)),
    pendingFiles: pending.length,
  };
}
