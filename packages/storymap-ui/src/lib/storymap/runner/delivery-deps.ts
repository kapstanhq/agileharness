// O lado IMPURO da página de Entrega: git, config e os coletores que já existem.
//
// Espelha a divisão de `fleet-view` / `fleet-deps`: a projeção e as réguas ficam em `delivery-view`
// (puras, testáveis sem subir nada) e aqui mora só a leitura do mundo. Toda consulta é BEST-EFFORT —
// uma página de diagnóstico que falha inteira porque um `git rev-parse` não respondeu é pior que uma
// página com um campo vazio.

import { collectFleet } from "./fleet-view";
import { defaultFleetDeps } from "./fleet-deps";
import { listPublishRequests } from "./publish-queue";
import { releaseCodePrefixes } from "./release-scope";
import {
  belongsToBoard,
  parseStagedLog,
  projectWork,
  stagedTotalOf,
  STAGED_LOG_FORMAT,
  type BoardFrontier,
  type DeliveryOverview,
} from "./delivery-view";
import { parsePorcelainZPaths } from "./session-activity";
import { loadRunnerConfig } from "./config";
import { defaultExec, type ExecFn } from "./worktree";
import { findRepoRoot } from "@/lib/storymap/paths";
import { listBoards, readBoardConfig } from "@/lib/storymap/repo";
import { mayRequestPublish, releaseModeOf } from "@/lib/storymap/release-policy";

/** Teto de commits listados por board — a raia mostra entregas, não o histórico do repositório. */
const MAX_STAGED = 30;
/** Teto de pedidos no histórico da fila — o suficiente para a raia "No ar" e a trilha recente. */
const MAX_PUBLISH_ROWS = 12;
const GIT_TIMEOUT_MS = 20_000;

const q = (s: string): string => JSON.stringify(s);

/** Os ids dos boards, best-effort — falha de leitura vira lista vazia, nunca uma página que explode. */
async function listBoardIds(): Promise<string[]> {
  return listBoards()
    .then((bs) => bs.map((b) => b.id))
    .catch(() => []);
}

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
 * compartilhado, e a página prometeria publicar algo que a promoção deste board não leva.
 *
 * Exportada para o teste: é o número que decide publicar, e a régua dele são os ARGUMENTOS do git
 * (base, pathspec, exclusão do que já está no ar). Testar isso por `collectDelivery` mediria a
 * orquestração e deixaria a régua sem cobertura.
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

  const prefixes = releaseCodePrefixes(boardConfig, cfg.staging.codePrefixes);
  const pathspec = prefixes.length ? ` -- ${prefixes.map(q).join(" ")}` : "";
  // "ainda não no ar" tem de ser medido contra o que ESTÁ no ar, e a fronteira do board sozinha não
  // mede isso: `base..stage` é "alcançável do stage e não da fronteira", o que inclui o que voltou de
  // `main` para o stage no refluxo. Foi assim que o `release:` de OUTRO board (que tocou
  // `packages/orbit*`, dentro do pathspec do acme) apareceu como entrega pendente do acme por 5 dias
  // — anunciado como "ainda não no ar" sendo literalmente ancestral de HEAD.
  //
  // Excluir por `liveSha` (não por `main`) casa o número com a sha que a faixa mostra em "No ar": as
  // duas leituras passam a vir do mesmo instante, então o contador nunca contradiz o que está do lado.
  // E não há falso negativo: a promoção RE-COMMITA o delta, então trabalho pendente de verdade jamais é
  // ancestral do que está no ar — só o refluxo é, que é exatamente o que queremos tirar.
  const notLive = liveSha ? ` --not ${q(liveSha)}` : "";
  // A LISTA é capada (a raia mostra entregas, não o histórico do repositório) mas a CONTAGEM não pode
  // ser: "N entregas ainda não no ar" e o contador da raia liam `staged.length`, então acima do teto eles
  // reportavam 30 como se fosse o total. É o mesmo defeito do contador de "No ar" (uma janela truncada
  // apresentada como resposta) — e o mais caro dos dois, porque este número é o que decide publicar.
  const [log, count] = await Promise.all([
    git(
      exec,
      `log --no-merges --max-count=${MAX_STAGED} --format=${q(STAGED_LOG_FORMAT)} ${q(base)}..${q(stageBranch)}${notLive}${pathspec}`,
    ),
    git(exec, `rev-list --no-merges --count ${q(base)}..${q(stageBranch)}${notLive}${pathspec}`),
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
    stagedTotal: stagedTotalOf(count, staged.length),
  };
}


/** Janela em que um batimento recente dispensa a sondagem — ver `FRESH_MS` no modelo puro. */
const PROBE_AFTER_MS = 10 * 60_000;

/**
 * A árvore desta sessão tem trabalho NÃO-COMMITADO? `null` quando não deu para saber.
 *
 * Um `git status --porcelain` por sessão AMBÍGUA (só as caladas há mais de 10min — quem acabou de dar
 * sinal está obviamente trabalhando e não custa nada). É o mesmo comando que a varredura de worktrees
 * já roda, e reusa o parser puro dela; o que muda é a PERGUNTA: lá é "foi tocada dentro da janela?"
 * (para não apagar trabalho), aqui é "sobrou alguma coisa fora do git?" (para não chamar de "em curso"
 * uma sessão que já entregou e só esqueceu a árvore aberta).
 */
async function worktreePending(path: string, exec: ExecFn): Promise<boolean | null> {
  try {
    const { stdout } = await exec(`git status --porcelain -z -uall`, { cwd: path, timeout: 10_000 });
    return parsePorcelainZPaths(String(stdout)).length > 0;
  } catch {
    return null; // não deu para provar que acabou ⇒ o modelo puro trata como "trabalhando"
  }
}

/**
 * O panorama, ESCOPADO ao board pedido.
 *
 * O escopo é o conserto de uma mistura que só não aparece com um board só: "Em curso" filtrava por board
 * enquanto train, stage e fronteiras vinham do sistema inteiro — números que não fecham entre si e que o
 * operador não tem como atribuir. Agora todas as raias respondem sobre o MESMO recorte, e o que não tem
 * board (trabalho de sessão sem card, `board: ""`) aparece em todas por desenho (`belongsToBoard`):
 * escondê-lo seria refazer por filtro o buraco que a raia única acabou de fechar.
 *
 * Sem `boardId` (o atalho legado `/entrega`) mostra TODOS os boards. Antes mostrava só os que estavam
 * na lista `publishQueue.boards` — o que, agora que todo board é liberável, esconderia exatamente os
 * que acumulam sem publicar sozinhos. `publishTotals` é sempre contado ANTES do truncamento.
 */
export async function collectDelivery(exec: ExecFn = defaultExec, boardId?: string): Promise<DeliveryOverview> {
  // Com board pedido, medimos a fronteira DELE — inclusive quando ele não publica sozinho, para a
  // página poder oferecer o botão em vez de aparecer vazia (`BoardFrontier.releaseMode`).
  const boards = boardId ? [boardId] : await listBoardIds();
  const [fleetAll, publishAll] = await Promise.all([
    collectFleet(defaultFleetDeps()).catch(() => []),
    listPublishRequests().catch(() => []),
  ]);
  const fleet = boardId ? fleetAll.filter((r) => belongsToBoard(r.board, boardId)) : fleetAll;
  const publishScoped = boardId ? publishAll.filter((r) => r.board === boardId) : publishAll;
  const frontiers = await Promise.all(boards.map((b) => frontierOf(b, exec).catch(() => null)));

  // Sonda SÓ as sessões ambíguas: com árvore e caladas há mais de 10min. As demais respondem sozinhas
  // (batimento fresco = trabalhando), e assim o custo não cresce com o tamanho da frota ATIVA.
  const now = Date.now();
  const ambiguous = fleet.filter(
    (r) => r.worktreePath && now - Date.parse(r.heartbeatAt) >= PROBE_AFTER_MS,
  );
  const pending = new Map<string, boolean>();
  await Promise.all(
    ambiguous.map(async (r) => {
      const v = await worktreePending(r.worktreePath!, exec);
      if (v !== null) pending.set(r.sessionId, v);
    }),
  );

  return {
    frontiers: frontiers.filter((f): f is BoardFrontier => !!f),
    work: projectWork(fleet, pending),
    publish: publishScoped.slice(0, MAX_PUBLISH_ROWS),
    // Contados sobre a fila INTEIRA (do recorte), nunca sobre a janela acima — ver `publishTotals`.
    publishTotals: {
      published: publishScoped.filter((r) => r.status === "published").length,
      open: publishScoped.filter((r) => r.status === "waiting" || r.status === "publishing").length,
    },
    generatedAt: new Date().toISOString(),
  };
}
