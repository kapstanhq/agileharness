// A ENTREGA — o modelo de leitura de "onde está cada trabalho, do worktree até produção".
//
// Por que existe: as peças do caminho já eram todas observáveis, mas cada uma por uma superfície
// diferente — a frota e o train em `/processes`, o par stage/main só por `git`, e a FILA DE PUBLICAÇÃO
// por lugar nenhum (era MCP-only: um pedido segurado escrevia um `reason` excelente que nenhum
// navegador conseguia ler). Responder "meu código subiu?" custava quatro consultas e a cabeça do
// operador para juntá-las. Este módulo faz a junção UMA vez, em cima das fontes que já existem.
//
// NÃO é uma segunda verdade: as sessões vêm de `collectFleet` (a mesma coleta da frota), o train vem do
// `train` que cada FleetRow já carrega, o escopo do delta vem de `release-scope` (o mesmo que a promoção
// usa) e os pedidos vêm de `publish-queue`. Aqui só há PROJEÇÃO e ORDENAÇÃO.
//
// PURO por construção: nada de fs, git ou config — o chamador injeta (ver `delivery-deps.ts`). É o que
// deixa a régua das raias e a leitura de "quem segura quem" testáveis sem subir serviço nenhum.

import { isActiveMergeStatus, isLiveMergeStatus } from "./merge-status";
import type { FleetRow } from "./fleet-view";
import type { PublishRequest } from "./publish-queue";
import type { MergeQueueStatus } from "./types";
import type { ReleaseMode } from "@/lib/storymap/types";

/** Os quatro degraus que TODA entrega percorre — a régua única da página. */
export type DeliveryLane = "editing" | "train" | "stage" | "live";

/** Desfechos do train que PARARAM com o trabalho fora do stage — a entrega existe e não anda sozinha. */
const TRAIN_STUCK: ReadonlySet<MergeQueueStatus> = new Set<MergeQueueStatus>([
  "gate-failed",
  "conflict",
  "returned-to-session",
  "failed",
]);

/** Um trabalho ainda em mãos de uma sessão: editando, ou já entregue ao train. */
export interface DeliveryWork {
  /** a identidade LÓGICA do agente (estável entre reciclagens) — a chave da linha. */
  key: string;
  sessionId: string;
  /** o que a sessão declarou fazer ao abrir o worktree. É o NOME da entrega para o operador. */
  title: string;
  board: string | null;
  cardId: string | null;
  alive: boolean;
  heartbeatAt: string;
  lane: Extract<DeliveryLane, "editing" | "train">;
  train: { status: MergeQueueStatus; pinnedSha: string | null; enqueuedAt: number } | null;
  /** o train parou com este trabalho e ninguém vai agir sozinho (desfecho terminal fora do stage). */
  stuck: boolean;
  /** integração que voltou para um agente que já morreu — ninguém a assume (vem do FleetRow). */
  orphaned: boolean;
  /**
   * A árvore dela tem trabalho NÃO-COMMITADO agora? `null` = não deu para saber (sondagem falhou, ou
   * a sessão não tem árvore). É o único sinal que separa "trabalhando" de "já entregou e esqueceu a
   * árvore aberta" — o batimento sozinho não separa: ele só diz quando a sessão falou com o MCP pela
   * última vez, e uma sessão que terminou fica calada exatamente como uma que está pensando.
   */
  pending: boolean | null;
}

/**
 * O estado REAL de uma sessão, na ordem em que interessa ao operador:
 *
 *   • `working`  — tem trabalho na árvore, ou acabou de dar sinal, ou o train está mexendo nela.
 *   • `delivered`— entregou (a entrada dela no train está `done`), a árvore está limpa e ela emudeceu.
 *                  A árvore aberta não é inofensiva: enquanto existir, ela SEGURA a publicação de quem
 *                  tocar os mesmos arquivos (guarda de concorrência). É o caso mais caro de ficar
 *                  invisível — foi ele que segurou uma publicação por 98 tentativas em 2026-07-28.
 *   • `idle`     — calada, sem trabalho na árvore e sem entrega recente: resquício.
 *
 * PURO: recebe `now` e as janelas. A dúvida (`pending === null`) sempre pende para `working` — dizer
 * "acabou" sobre trabalho que talvez exista é o erro caro; o contrário só ocupa uma linha na tela.
 */
export type WorkState = "working" | "delivered" | "idle";

/** Falou com o MCP há tão pouco tempo que não vale nem perguntar à árvore. */
export const FRESH_MS = 10 * 60_000;

export function workState(
  w: Pick<DeliveryWork, "pending" | "heartbeatAt" | "train">,
  now: number,
  freshMs: number = FRESH_MS,
): WorkState {
  const beat = Date.parse(w.heartbeatAt);
  if (Number.isFinite(beat) && now - beat < freshMs) return "working";
  if (w.train && trainIsMoving(w.train.status)) return "working";
  if (w.pending !== false) return "working"; // true (tem trabalho) ou null (não sei) ⇒ não afirme que acabou
  return w.train?.status === "done" ? "delivered" : "idle";
}

/** Um commit já integrado ao stage e ainda não promovido: uma entrega pronta, invisível para quem usa. */
export interface StagedDelivery {
  sha: string;
  subject: string;
  at: string;
  /** a sessão que a produziu, quando o assunto do commit a nomeia. */
  sessionId?: string;
}

/** A fronteira de um board: o que está no ar, o que está no stage e o que separa os dois. */
export interface BoardFrontier {
  board: string;
  /**
   * Como a publicação deste board é ORIGINADA (`board.yaml release.mode`). `manual` = acumula até
   * alguém pedir; `auto` = o sistema pede sozinho. NÃO é permissão: em ambos a página oferece o botão.
   */
  releaseMode: ReleaseMode;
  /**
   * A máquina de publicação existe (kill-switch global + staging)? É a permissão, e ela independe do
   * board — separá-la do modo é a correção: uma flag só respondia as duas e apagava o botão junto.
   */
  canPublish: boolean;
  liveSha: string | null;
  liveAt: string | null;
  stageSha: string | null;
  /** as entregas LISTADAS — capadas para a raia mostrar entregas, não o histórico do repositório. */
  staged: StagedDelivery[];
  /**
   * Quantas entregas existem de fato entre a fronteira publicada e o stage. Separado de `staged.length`
   * porque a lista é TRUNCADA: acima do teto, contar a lista fazia "N entregas ainda não no ar" reportar
   * o teto como se fosse o total — e este é o número que decide publicar.
   */
  stagedTotal: number;
}

export interface DeliveryOverview {
  frontiers: BoardFrontier[];
  work: DeliveryWork[];
  /** histórico recente da fila (mais novos primeiro) — a raia "No ar" e a trilha de auditoria. TRUNCADO. */
  publish: PublishRequest[];
  /**
   * Os totais sobre a fila INTEIRA, não sobre a janela truncada acima.
   *
   * Existe porque a raia "No ar" contava dentro do recorte e anunciava o resultado como histórico: com 99
   * publicações no disco, a tela dizia "6" e "mais 1 no histórico da fila". Um contador que promete o
   * histórico e entrega a página é pior que não ter contador — ele parece uma resposta.
   */
  publishTotals: { published: number; open: number };
  generatedAt: string;
}

/**
 * A raia de um trabalho: o train está com ele, ou a sessão está?
 *
 * A régua é EXATAMENTE {@link trainInFlight} — de propósito, e isto é correção de um buraco real. Antes
 * havia DUAS: esta mandava para `train` tudo que não fosse `done`, enquanto a raia do train renderizava
 * só o que `trainInFlight` aprova. A diferença entre as duas — `failed` e `returned-to-session` — caía no
 * vão: fora de "Em curso" (a raia diz `train`) e fora de "No train" (o filtro diz que não). O trabalho
 * SUMIA DA PÁGINA INTEIRA. E não é trabalho qualquer: `returned-to-session` significa literalmente "isto
 * voltou para você", o único estado em que a sessão PRECISA agir. Havia duas entradas assim no runtime
 * quando o buraco foi encontrado.
 *
 * Com uma régua só: em voo ou parado esperando o operador ⇒ `train` (é lá que o trabalho está); qualquer
 * outra coisa ⇒ `editing`, a sessão. Inclui `done` — a entrada representa UMA entrega, não a sessão:
 * integrada, ela reaparece na raia do stage (medida pelo git, que é quem sabe se aterrissou), enquanto a
 * SESSÃO segue viva e provavelmente já escrevendo a próxima. E inclui os desfechos devolvidos, que voltam
 * às mãos de quem submeteu — marcados com `stuck`, que é o que os põe no topo pedindo atenção.
 */
export function laneOf(row: Pick<FleetRow, "train">): Extract<DeliveryLane, "editing" | "train"> {
  return row.train && trainInFlight(row.train.status) ? "train" : "editing";
}

/**
 * Este item pertence à visão DESTE board? Um item SEM board pertence a todas — e isso não é frouxidão:
 * trabalho de sessão sem card nasce com `board: ""` (ADR-065 D2), e escondê-lo do único lugar que conta
 * onde o trabalho está seria reproduzir, por filtro, o mesmo buraco que {@link laneOf} acabou de fechar.
 *
 * Existe porque a página misturava escopos: "Em curso" filtrava por board enquanto train, stage e
 * fronteiras vinham do sistema inteiro. Num board só ninguém nota; com dois, as contas não fecham e o
 * operador não tem como saber qual número fala com ele.
 */
export function belongsToBoard(itemBoard: string | null | undefined, boardId: string): boolean {
  return !itemBoard || itemBoard === boardId;
}

/**
 * Esta sessão é uma das que SEGURAM este pedido de publicação?
 *
 * Casa contra `PublishRequest.heldBy` — os donos estruturados que a promoção reporta (`agent/<sessionId>`,
 * `fila:<runId>`, ou a descrição de uma sessão adotada), NÃO contra a prosa do `reason`. Aceita sessionId
 * e agentId porque a árvore pertence ao agente, que sobrevive à reciclagem da sessão.
 *
 * O `includes` é sobre um UUID dentro de um identificador curto e estruturado — não sobre uma frase. É a
 * diferença entre uma junção estável e uma que quebra quando alguém melhora o texto da mensagem.
 */
export function holdsPublish(work: Pick<DeliveryWork, "sessionId" | "key">, req: Pick<PublishRequest, "heldBy">): boolean {
  const owners = req.heldBy ?? [];
  if (owners.length === 0) return false;
  return owners.some((o) => o.includes(work.sessionId) || o.includes(work.key));
}

/**
 * O que uma entrega staged está esperando. A raia inteira promete algo ao operador, e antes desta
 * régua ela prometia o que não podia cumprir.
 *
 * `awaiting-request` é o estado do board `manual`: o trabalho está PRONTO — integrado, sem conflito,
 * esperando alguém pedir. Não é "agendado" (ninguém agendou) nem "travado" (o botão está ali). Antes
 * toda linha dizia "vai junto na próxima publicação" mesmo onde não havia próxima publicação nenhuma,
 * e foi assim que 7 commits do `acme` pareceram agendados enquanto ficavam 6 dias parados.
 *
 * `held` vem PRIMEIRO de propósito: um pedido segurado é um fato sobre aquele pedido, e continua
 * verdade mesmo que a política mude por baixo dele (ordem que só importa nessa corrida rara, mas cuja
 * alternativa seria apagar da tela o único estado que pede decisão).
 */
export type StagedState = "held" | "queued" | "head-scheduled" | "rides-along" | "awaiting-request";

export function stagedState(o: {
  /** é o commit mais novo do stage — o que um pedido pina, levando os demais de carona. */
  isHead: boolean;
  /** existe pedido de publicação para o topo do stage. */
  hasRequest: boolean;
  /** esse pedido está SEGURADO pelo embargo de concorrência. */
  held: boolean;
  /** como a publicação deste board é originada. */
  releaseMode: ReleaseMode;
}): StagedState {
  if (o.held) return "held";
  // Com pedido aberto o modo não importa: o que vale é que ele existe — foi pedido por um humano, por
  // um agente autorizado ou pelo produtor do `auto`, e a partir daqui a máquina é a mesma.
  if (o.hasRequest) return o.isHead ? "queued" : "rides-along";
  if (o.releaseMode === "manual") return "awaiting-request";
  return o.isHead ? "head-scheduled" : "rides-along";
}

/**
 * Projeta a frota nas duas primeiras raias, na ordem em que o operador precisa ver: primeiro o que
 * PAROU (train travado / integração órfã), depois o que anda, depois o que está calado. Dentro de cada
 * grupo, o batimento mais recente primeiro — "quem mexeu por último" é o que responde "isto é agora?".
 */
export function projectWork(
  rows: readonly FleetRow[],
  /** sessionId → a árvore tem trabalho não-commitado? Ausente ⇒ `null` (não sei) para todas. */
  pending?: ReadonlyMap<string, boolean>,
): DeliveryWork[] {
  const out: DeliveryWork[] = [];
  for (const row of rows) {
    const lane = laneOf(row);
    const stuck = !!row.train && TRAIN_STUCK.has(row.train.status);
    out.push({
      key: row.agentId || row.sessionId,
      sessionId: row.sessionId,
      title: row.task,
      board: row.board,
      cardId: row.cardId,
      alive: row.alive,
      heartbeatAt: row.heartbeatAt,
      lane,
      train: row.train,
      stuck,
      orphaned: !!row.orphanedIntegration,
      pending: pending?.get(row.sessionId) ?? null,
    });
  }
  return out.sort((a, b) => rank(a) - rank(b) || (a.heartbeatAt < b.heartbeatAt ? 1 : -1));
}

/** 0 = pede atenção agora · 1 = andando · 2 = viva e calada · 3 = adormecida. */
function rank(w: DeliveryWork): number {
  if (w.stuck || w.orphaned) return 0;
  if (w.train && trainIsMoving(w.train.status)) return 1;
  return w.alive ? 2 : 3;
}

/**
 * O train está mexendo neste trabalho AGORA (vs. parado num desfecho)?
 *
 * É `isActiveMergeStatus` MAIS `re-driving`, e a diferença é a razão de as duas réguas existirem: para o
 * MOTOR, `re-driving` é terminal (o branch foi deletado, um run novo foi despachado, e por isso ele não
 * pode segurar a cabeça da fila nem sobreviver a um cap); para quem OLHA a tela, "re-executando" é
 * movimento — esconder isso mostraria uma raia parada com trabalho acontecendo. Derivar em vez de
 * relistar deixa a diferença explícita: é UM termo somado, visível, e não duas listas para conferir.
 */
export function trainIsMoving(status: MergeQueueStatus): boolean {
  return isActiveMergeStatus(status) || status === "re-driving";
}

/**
 * Esta entrada pertence à raia do train — isto é, o train ainda vai mexer nela (anda) ou ela está
 * parada esperando o OPERADOR (`gate-failed`/`conflict`, a mesma régua de "Travados" de `/processes`).
 *
 * O que fica de fora é o que a fila guarda como HISTÓRIA: `done` (já virou commit no stage, e quem a
 * mede dali em diante é o git) e os terminais `failed` / `returned-to-session`. Sem este corte a raia
 * mentia por acúmulo: em produção ela mostrava "2" havia dias — um `failed` de 150h e um
 * `returned-to-session` de 106h cuja sessão dona já não existia —, dois cadáveres numa raia que promete
 * dizer o que está em voo, cada um com um "Destravar em Processos →" que não leva a lugar nenhum
 * (`/processes` também não os trata como travados). Um número que nunca zera deixa de ser sinal.
 */
export function trainInFlight(status: MergeQueueStatus): boolean {
  return isLiveMergeStatus(status) || status === "re-driving";
}

/**
 * Os pedidos que ainda podem mudar sozinhos — os únicos sobre os quais uma ação faz sentido. Um pedido
 * resolvido é história: a página o mostra, mas não oferece botão.
 */
export function openRequests(rows: readonly PublishRequest[]): PublishRequest[] {
  return rows.filter((r) => r.status === "waiting" || r.status === "publishing");
}

/**
 * Os pedidos SEGURADOS: esperando há tempo suficiente para o sistema já ter dito por quê. É o único
 * item da página que pede uma decisão humana, e era exatamente o que não tinha superfície nenhuma —
 * `heldSince`/`heldCount`/`reason` existiam no disco e morriam lá.
 */
export function heldRequests(rows: readonly PublishRequest[]): PublishRequest[] {
  return rows.filter((r) => r.status === "waiting" && !!r.heldSince);
}

/**
 * Espera longa com contagem alta é BLOQUEIO, não lentidão — a régua que a doc do `publish_status` já
 * prescreve, aqui como código para ninguém a reinventar por olhômetro.
 *
 * É A régua, no singular: além da UI, o DRENO a consulta para disparar o aviso na borda em que um pedido
 * vira bloqueio (`publish-queue` `onBlocked`). Uma segunda cópia lá seria a que apodrece — e apodreceria
 * calada, porque as duas só divergem no dia em que alguém mexer num dos limiares.
 */
export function isBlocked(req: PublishRequest, now: number, opts?: { minMs?: number; minCount?: number }): boolean {
  if (req.status !== "waiting" || !req.heldSince) return false;
  const minMs = opts?.minMs ?? 10 * 60_000;
  const minCount = opts?.minCount ?? 10;
  const held = now - Date.parse(req.heldSince);
  return Number.isFinite(held) && held >= minMs && (req.heldCount ?? 0) >= minCount;
}

/**
 * O pedido aberto que corresponde ao topo do stage deste board — o que decide se a raia "No stage"
 * mostra "esperando janela", "segurada" ou o botão de publicar. Casa por (board, sha) porque é essa a
 * chave de idempotência do enqueue: um pedido de um sha ANTIGO não fala pelo stage de agora.
 */
/**
 * A entrega MAIS RECENTE do stage — a que a próxima publicação leva no topo.
 *
 * NÃO é `stageSha`, e essa diferença mordeu: a listagem usa `--no-merges` (um merge não é uma entrega),
 * então sempre que o topo do stage é um `Merge branch 'main' into stage` — o caso comum depois de uma
 * promoção — NENHUM sha listado é igual ao do branch, e um `sha === stageSha` fica permanentemente falso.
 * O rótulo "topo do stage" simplesmente nunca aparecia, e ninguém notava porque o rótulo anterior
 * ("pronta para publicar") era igual nas duas pontas.
 *
 * `requestForStage` continua casando por `stageSha`, e está certo: o PEDIDO pina o topo real do branch,
 * merge inclusive. São perguntas diferentes — "que commit o pedido escolheu" × "qual entrega está no topo".
 */
export function headOfStaged(staged: readonly StagedDelivery[]): string | null {
  return staged[0]?.sha ?? null; // o log vem do mais novo para o mais velho
}

export function requestForStage(
  rows: readonly PublishRequest[],
  board: string,
  stageSha: string | null,
): PublishRequest | null {
  if (!stageSha) return null;
  return openRequests(rows).find((r) => r.board === board && r.requestedSha === stageSha) ?? null;
}

// ── Parse do log de commits staged ───────────────────────────────────────────────────────────────

/**
 * O formato do `git log` que {@link parseStagedLog} entende: sha, data ISO e assunto, NESTA ordem,
 * separados por espaço. Os dois primeiros campos nunca contêm espaço, então o assunto — que contém — é
 * simplesmente "o resto da linha". Deliberadamente SEM `%x00`: um separador NUL viaja mal neste
 * repositório (o split do merge train quebra em arquivo com byte NUL) e não compraria nada aqui.
 */
export const STAGED_LOG_FORMAT = "%H %cI %s";

/** `usm(sessão): código staged (sessão <uuid>)` — o rastro que liga um commit do stage à sessão dona. */
const SESSION_IN_SUBJECT = /\(sess(?:ão|ao)\s+([0-9a-f-]{8,})\)/i;

/**
 * Converte a saída de `git log --format=${STAGED_LOG_FORMAT}` em entregas. Tolerante por LINHA (uma
 * linha malformada é descartada, não derruba a lista) — mesmo princípio do journal: um artefato de
 * diagnóstico nunca pode ficar em branco por causa de um registro estranho.
 */
/**
 * Quantas entregas existem de fato, dado o `git rev-list --count` e o que coube na lista truncada.
 *
 * A regra que importa é a de FALHA: contagem ilegível — ou menor que a própria lista, o que só acontece
 * se as duas leituras discordarem — cai no tamanho da lista. Sub-reportar é o erro barato (a página
 * mostra o que tem); inventar um total é o caro, porque este é o número em cima do qual alguém aperta
 * "Publicar". Vizinho de `parseStagedLog` de propósito: mesma família, mesma disciplina de tolerar
 * saída estranha do git em vez de confiar nela.
 */
export function stagedTotalOf(countStdout: string | null | undefined, listed: number): number {
  const n = Number.parseInt((countStdout ?? "").trim(), 10);
  return Number.isFinite(n) && n >= listed ? n : listed;
}

export function parseStagedLog(stdout: string): StagedDelivery[] {
  const out: StagedDelivery[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const firstSpace = trimmed.indexOf(" ");
    if (firstSpace < 0) continue;
    const sha = trimmed.slice(0, firstSpace);
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) continue;
    const rest = trimmed.slice(firstSpace + 1);
    const secondSpace = rest.indexOf(" ");
    const at = secondSpace < 0 ? rest : rest.slice(0, secondSpace);
    if (!at) continue;
    const subject = secondSpace < 0 ? "" : rest.slice(secondSpace + 1).trim();
    const sessionId = subject.match(SESSION_IN_SUBJECT)?.[1];
    out.push({ sha, subject, at, ...(sessionId ? { sessionId } : {}) });
  }
  return out;
}
