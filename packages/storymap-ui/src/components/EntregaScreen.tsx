"use client";

// ESTEIRA — onde cada trabalho está, do worktree até produção.
//
// O nome na tela é ESTEIRA; o id da rota, do componente e do arquivo segue `entrega` (links e
// bookmarks antigos valem). Ela se chamava "Entrega" e colidia com a COLUNA "Entrega" do Kanban —
// duas coisas de níveis diferentes com o mesmo nome: lá é a FASE de uma story (aprovar e publicar UM
// card), aqui é a MÁQUINA por baixo (o código de todos eles andando ao mesmo tempo). O Kanban aponta
// para cá pelo `columns[].tool` do board.yaml, não por um link cravado.
//
// Uma view DO BOARD (bloco Software): veste o MESMO `BoardHeader` das irmãs, então a barra de topo não
// é parecida com a do resto do app — é a mesma. Foi o board que trouxe o contexto que faltava: com ele
// cada linha diz QUAL CARD serve e mostra o estado VIVO dele.
//
// Quatro raias, uma por degrau: EM CURSO (um agente trabalhando: run do pipeline ou sessão com
// worktree) → NO TRAIN (gate + merge) → NO STAGE (integrado, invisível para quem usa) → NO AR. Mais a
// faixa da fronteira (main × stage) e o bloco de publicação segurada, que é a única coisa aqui que
// pede decisão humana.
//
// O que esta página NÃO faz: reinventar vocabulário. "Rodando / na fila / integrando / conflito /
// aguardando / falhou" vem do `RunSubstateBadge` — o MESMO componente que o card do Kanban usa, lendo
// os mesmos snapshots vivos. Se um dia o verbo mudar lá, muda aqui junto; e o operador não precisa
// aprender duas línguas para a mesma coisa. O que travou e precisa de intervenção continua sendo
// assunto de `/processes`; aqui a leitura é de FLUXO.

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { AlertTriangle, ChevronDown, ChevronRight, GitMerge, Play, Rocket, ShieldAlert, Upload } from "lucide-react";
import { cn } from "@/lib/cn";
import { cardEyebrow, cardSurfaceSm, countChipCls, idChip } from "@/lib/ui";
import { BoardHeader } from "./BoardHeader";
import { ToastProvider, useToast } from "./Toast";
import { ConfirmDialog } from "./ConfirmDialog";
import { RunSubstateBadge, useMergeQueue, useRunnerSnapshot } from "./RunnerStatusProvider";
import { cancelPublishAction, getDeliveryOverviewAction, publishStagedAction } from "@/app/delivery-actions";
import {
  belongsToBoard,
  headOfStaged,
  heldRequests,
  holdsPublish,
  isBlocked,
  requestForStage,
  stagedState,
  trainInFlight,
  trainIsMoving,
  workState,
  type BoardFrontier,
  type DeliveryOverview,
  type DeliveryWork,
  type StagedDelivery,
  type StagedState,
} from "@/lib/storymap/runner/delivery-view";
import type { ReleaseMode } from "@/lib/storymap/types";
import type { PublishRequest } from "@/lib/storymap/runner/publish-queue";
import type { Board, BoardSummary } from "@/lib/storymap/types";
import type { MergeQueueEntry, MergeQueueStatus, RunnerRun } from "@/lib/storymap/runner/types";

/** Repesca de git + fila. Esparso de propósito: nada aqui muda em segundos, e cada volta gasta git. */
const POLL_MS = 20_000;
/** Quantas publicações a raia "No ar" LISTA (o contador conta o histórico inteiro). */
const LIVE_SHOWN = 5;
/** Sem batimento há mais que isto, uma sessão é RESQUÍCIO: some da lista principal (vai para o rodapé). */
const DORMANT_MS = 60 * 60_000;

export function EntregaScreen({
  board,
  boards,
  initial,
  cardTitles,
}: {
  board: Board;
  boards: BoardSummary[];
  initial: DeliveryOverview;
  cardTitles: Record<string, string>;
}) {
  return (
    <ToastProvider>
      <div className="flex min-h-screen flex-col bg-canvas">
        <BoardHeader boards={boards} config={board.config} view="entrega" subnav />
        {/* Folga para a bottom-nav FIXA do celular (h-14 + safe-area) — sem ela a última linha da raia
            fica atrás da barra. No desktop a barra não existe e a folga volta ao normal. */}
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 pb-24 pt-6 md:pb-6">
          <EntregaBody boardId={board.config.id} initial={initial} cardTitles={cardTitles} />
        </main>
      </div>
    </ToastProvider>
  );
}

function EntregaBody({
  boardId,
  initial,
  cardTitles,
}: {
  boardId: string;
  initial: DeliveryOverview;
  cardTitles: Record<string, string>;
}) {
  const [data, setData] = useState<DeliveryOverview>(initial);
  const mq = useMergeQueue();
  const { running } = useRunnerSnapshot();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState<null | { kind: "override" | "cancel"; board: string; id?: string }>(null);

  // Uma repescagem por vez, e nunca com a aba escondida — uma página de diagnóstico aberta num monitor
  // esquecido não tem por que rodar `git log` a noite inteira.
  const inFlight = useRef(false);
  const refresh = useCallback(async () => {
    if (inFlight.current || typeof document === "undefined" || document.visibilityState === "hidden") return;
    inFlight.current = true;
    try {
      const r = await getDeliveryOverviewAction(boardId);
      if (r.ok && r.data) setData(r.data);
    } finally {
      inFlight.current = false;
    }
  }, [boardId]);

  useEffect(() => {
    const timer = setInterval(refresh, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  // O train mexeu ⇒ o stage pode ter andado: repescar na BORDA faz a fronteira acompanhar uma
  // integração sem esperar o intervalo inteiro.
  const trainSignature = (mq?.entries ?? []).map((e) => `${e.runId}:${e.status}`).join("|");
  useEffect(() => {
    if (trainSignature) void refresh();
  }, [trainSignature, refresh]);

  const act = (fn: () => Promise<{ ok: boolean; error?: string }>, okMsg: string) => {
    startTransition(async () => {
      const r = await fn();
      if (r.ok) {
        toast(okMsg, "success");
        await refresh();
      } else {
        toast(r.error ?? "Não deu certo.", "error");
      }
    });
  };
  const publish = (b: string, overrideEmbargo = false) =>
    act(
      () => publishStagedAction({ board: b, overrideEmbargo }),
      overrideEmbargo ? "Publicação enfileirada com o embargo dispensado." : "Publicação enfileirada.",
    );
  const cancel = (id: string, b: string) => act(() => cancelPublishAction({ id, board: b }), "Pedido cancelado.");

  const held = heldRequests(data.publish);
  const published = useMemo(() => data.publish.filter((r) => r.status === "published"), [data.publish]);

  // O relógio da tela. Sem ele os rótulos relativos ("há 6 min", "retenta em 12s") só mudavam no poll de
  // 20s — e uma tela cujos números não se mexem lê-se como travada, que é exatamente a dúvida que esta
  // página existe para responder. Barato: nenhum IO, só um re-render.
  const now = useNow(10_000);

  // EM CURSO = runs do pipeline (um card sendo trabalhado por um agente headless) + sessões com
  // worktree aberto. As duas coisas são "alguém está mexendo nisto agora", e o operador não deveria
  // ter de saber qual das duas máquinas está por trás para achar o seu trabalho.
  // Quem segura a publicação AGORA — a junção estruturada (`heldBy`), não o texto do motivo.
  // DECLARADO AQUI, antes de qualquer balde: os filtros abaixo o leem dentro de um closure, e um `const`
  // definido depois deles é TDZ em runtime — o `tsc` não acusa (não sabe quando o closure roda) e só o
  // build de produção derruba a página. Já custou um render inteiro nesta sessão.
  const blockers = new Set(data.work.filter((w) => held.some((r) => holdsPublish(w, r))).map((w) => w.key));

  const boardRuns = running.filter((r) => r.board === boardId);
  const sessions = data.work.filter((w) => w.lane === "editing");
  const runCardIds = new Set(boardRuns.map((r) => r.cardId));
  // PENDÊNCIAS primeiro, e FORA dos baldes de estado: uma integração devolvida (`returned-to-session`) ou
  // órfã pede ação de alguém HOJE, e o balde a que ela pertenceria pelo relógio é justamente o que a
  // escondia — árvore limpa + sem batimento cai em "adormecida", um bloco recolhido que ninguém abre.
  const pendencias = sessions.filter((w) => w.stuck || w.orphaned || blockers.has(w.key));
  const resto = sessions.filter((w) => !w.stuck && !w.orphaned && !blockers.has(w.key));
  // O estado vem da ÁRVORE, não do relógio: uma sessão calada há 40min pode estar pensando (árvore
  // suja) ou já ter entregue e esquecido a árvore aberta. Chamar as duas de "em curso" era a mentira.
  const awake = resto.filter((w) => workState(w, now) === "working");
  const delivered = resto.filter((w) => workState(w, now) === "delivered");
  const dormant = resto.filter((w) => workState(w, now) === "idle");
  const emCurso = boardRuns.length + awake.length + pendencias.length;

  const titleBySession = useMemo(() => new Map(data.work.map((w) => [w.sessionId, w] as const)), [data.work]);
  // ESCOPADO como as demais raias (a merge queue vem do sistema inteiro pelo SSE). Trabalho sem board
  // aparece em todo board por desenho — ver `belongsToBoard`.
  const trainEntries = (mq?.entries ?? []).filter((e) => trainInFlight(e.status) && belongsToBoard(e.board, boardId));
  // A POSIÇÃO na fila: o train é FIFO por chegada entre os `waiting`, e "sou o 2º" é a resposta que a
  // pergunta "quem é o próximo de verdade?" pede. Calculada sobre a fila REAL (todos os boards), porque
  // é ela que serializa — mostrar posição dentro do recorte mentiria sobre quem vem antes.
  const waitingOrder = (mq?.entries ?? [])
    .filter((e) => e.status === "waiting")
    .sort((a, b) => a.enqueuedAt - b.enqueuedAt)
    .map((e) => e.runId);
  const staged = data.frontiers.flatMap((f) => f.staged.map((s) => ({ s, f, head: headOfStaged(f.staged) })));
  // O total REAL das fronteiras × o que coube na lista — a diferença vira uma linha, nunca um silêncio.
  const stagedTotal = data.frontiers.reduce((n, f) => n + f.stagedTotal, 0);

  return (
    <div className="flex flex-col gap-5">
      {data.frontiers.map((f) => (
        <FrontierStrip
          key={f.board}
          frontier={f}
          request={requestForStage(data.publish, f.board, f.stageSha)}
          busy={pending}
          now={now}
          onPublish={() => publish(f.board)}
        />
      ))}

      {held.map((req) => (
        <HeldBanner
          key={req.id}
          req={req}
          busy={pending}
          now={now}
          onOverride={() => setConfirming({ kind: "override", board: req.board })}
          onCancel={() => setConfirming({ kind: "cancel", board: req.board, id: req.id })}
        />
      ))}

      {/* A ordem do DOM é a do fluxo (esquerda→direita no desktop). No celular ela INVERTE por `order`:
          o que espera decisão sobe, o que está em curso é contexto e desce. */}
      <div className="grid grid-cols-1 gap-x-5 gap-y-6 md:grid-cols-2 xl:grid-cols-4">
        <Lane label="Em curso" count={emCurso} icon={Play} className="order-3 xl:order-none">
          {emCurso === 0 && <LaneEmpty>Nenhum agente trabalhando neste board agora.</LaneEmpty>}
          {/* O que PAROU nas mãos de alguém vem primeiro e nunca recolhido: uma integração devolvida é o
              único estado em que a sessão PRECISA agir, e era o que sumia da página inteira. */}
          {pendencias.map((w) => (
            <SessionRow
              key={w.key}
              work={w}
              boardId={boardId}
              cardTitles={cardTitles}
              hideCard={runCardIds}
              blocking={blockers.has(w.key)}
              now={now}
            />
          ))}
          {boardRuns.map((r) => (
            <RunRow key={`${r.board}/${r.cardId}`} run={r} title={cardTitles[r.cardId]} />
          ))}
          {awake.map((w) => (
            <SessionRow
              key={w.key}
              work={w}
              boardId={boardId}
              cardTitles={cardTitles}
              hideCard={runCardIds}
              blocking={blockers.has(w.key)}
              now={now}
            />
          ))}
          {/* JÁ ENTREGOU e deixou a árvore aberta. Não é "em curso" — e não é inofensivo: enquanto a
              árvore existir, ela SEGURA a publicação de quem tocar os mesmos arquivos. É a informação
              mais cara desta página, e era a que não existia em lugar nenhum. */}
          {delivered.length > 0 && (
            <Disclosure
              label={
                delivered.length === 1 ? "1 sessão já entregou" : `${delivered.length} sessões já entregaram`
              }
              tone="attention"
            >
              {delivered.map((w) => (
                <SessionRow
                  key={w.key}
                  work={w}
                  boardId={boardId}
                  cardTitles={cardTitles}
                  hideCard={runCardIds}
                  state="delivered"
                  blocking={blockers.has(w.key)}
                  now={now}
                />
              ))}
              <p className="px-0.5 pt-1 text-[11px] leading-snug text-fg-subtle">
                O trabalho delas já está integrado e a árvore continua aberta — o que SEGURA a publicação de
                quem tocar os mesmos arquivos (guarda de concorrência). Some sozinho quando a sessão fizer
                worktree_discard, ou quando a janela de 90 min sem sinal vencer.
              </p>
            </Disclosure>
          )}
          {dormant.length > 0 && (
            <Disclosure
              label={
                dormant.length === 1 ? "1 sessão adormecida" : `${dormant.length} sessões adormecidas`
              }
            >
              {dormant.map((w) => (
                <SessionRow key={w.key} work={w} boardId={boardId} cardTitles={cardTitles} hideCard={runCardIds} dim now={now} />
              ))}
              <p className="px-0.5 pt-1 text-[11px] leading-snug text-fg-subtle">
                Sem batimento há mais de 1h e sem nenhum pedido de publicação apontando para elas agora — a
                varredura libera a árvore sozinha. (Uma sessão que ESTIVESSE segurando uma publicação não
                estaria aqui: ela sobe para o topo desta raia, marcada.)
              </p>
            </Disclosure>
          )}
        </Lane>

        <Lane label="No train" count={trainEntries.length} icon={GitMerge} className="order-2 xl:order-none">
          {trainEntries.length === 0 && <LaneEmpty>Nada na fila de integração.</LaneEmpty>}
          {trainEntries.map((e) => (
            <TrainRow
              key={e.runId}
              entry={e}
              work={titleBySession.get(e.runId)}
              cardTitles={cardTitles}
              position={e.status === "waiting" ? waitingOrder.indexOf(e.runId) + 1 : 0}
              queueLength={waitingOrder.length}
              now={now}
            />
          ))}
        </Lane>

        <Lane label="No stage" count={stagedTotal} icon={Upload} className="order-1 xl:order-none">
          {staged.length === 0 && <LaneEmpty>Nada staged — o que está no ar é tudo o que existe.</LaneEmpty>}
          {staged.map(({ s, f, head }) => (
            <StagedRow
              key={s.sha}
              delivery={s}
              work={s.sessionId ? titleBySession.get(s.sessionId) : undefined}
              request={requestForStage(data.publish, f.board, f.stageSha)}
              isHead={s.sha === head}
              releaseMode={f.releaseMode}
              now={now}
            />
          ))}
          {stagedTotal > staged.length && (
            <p className="px-0.5 text-[11.5px] text-fg-subtle">
              ▸ mais {stagedTotal - staged.length} entrega(s) não listada(s) — todas vão na mesma publicação
            </p>
          )}
        </Lane>

        <Lane label="No ar" count={data.publishTotals.published} icon={Rocket} className="order-4 xl:order-none">
          {published.length === 0 && <LaneEmpty>Nenhuma publicação recente pela fila.</LaneEmpty>}
          {published.slice(0, LIVE_SHOWN).map((r) => (
            <PublishedRow key={r.id} req={r} now={now} />
          ))}
          {/* Conta sobre a fila INTEIRA. Antes contava dentro da janela truncada e chamava o resultado de
              histórico: com 99 publicações no disco, "6" e "mais 1 no histórico". */}
          {data.publishTotals.published > Math.min(published.length, LIVE_SHOWN) && (
            <p className="px-0.5 text-[11.5px] text-fg-subtle">
              ▸ mais {data.publishTotals.published - Math.min(published.length, LIVE_SHOWN)} no histórico da fila
            </p>
          )}
        </Lane>
      </div>

      <p className="text-[11.5px] text-fg-subtle">
        O que travou e precisa de você fica em{" "}
        <Link href="/processes" className="font-medium text-accent hover:underline">
          Processos
        </Link>
        . Esta página conta onde cada trabalho está.
      </p>

      {confirming?.kind === "override" && (
        <ConfirmDialog
          title="Publicar por cima do embargo?"
          description={
            "A guarda de concorrência acusou trabalho vivo nos mesmos arquivos. Publicar assim NÃO destrói nada " +
            "da outra sessão — o branch e a árvore dela seguem, e o 3-way do train reconcilia no próximo submit —, " +
            "mas o que vai ao ar não inclui o trabalho dela."
          }
          confirmLabel="Publicar mesmo assim"
          tone="danger"
          confirmDisabled={pending}
          onConfirm={() => {
            const b = confirming.board;
            setConfirming(null);
            publish(b, true);
          }}
          onCancel={() => setConfirming(null)}
        />
      )}
      {confirming?.kind === "cancel" && (
        <ConfirmDialog
          title="Cancelar o pedido de publicação?"
          description="O código continua no stage — só o pedido sai da fila. Dá para pedir de novo quando quiser."
          confirmLabel="Cancelar pedido"
          tone="danger"
          confirmDisabled={pending}
          onConfirm={() => {
            const { id, board: b } = confirming;
            setConfirming(null);
            if (id) cancel(id, b);
          }}
          onCancel={() => setConfirming(null)}
        />
      )}
    </div>
  );
}

// ── A fronteira: o que está no ar × o que está no stage ──────────────────────────────────────────

function FrontierStrip({
  frontier,
  request,
  busy,
  now,
  onPublish,
}: {
  frontier: BoardFrontier;
  request: PublishRequest | null;
  busy: boolean;
  /** o tique da página. Sem ele este `Ago` só reavaliava de carona no re-render do pai — funcionava,
   *  mas por efeito colateral: bastaria memoizar esta faixa para o "há N min" congelar para sempre. */
  now: number;
  onPublish: () => void;
}) {
  // O TOTAL, não o tamanho da lista: a listagem é capada e acima do teto `staged.length` reportaria o
  // teto como se fosse o total — no número que decide publicar.
  const ahead = frontier.stagedTotal;
  // A IDADE do lote — o segundo número que torna o clique informado. Vem do último item da lista, que
  // é a mais antiga (a lista é do mais novo para o mais velho). Com a lista capada este é o mais velho
  // LISTADO, não o do repositório: um piso honesto ("pelo menos isto"), nunca uma idade inventada.
  const oldest = frontier.staged.length ? ago(frontier.staged[frontier.staged.length - 1].at, true, now) : null;
  return (
    // No celular os três grupos EMPILHAM: lado a lado a 375px eles se atropelavam.
    <section
      className={cn(cardSurfaceSm, "flex flex-col gap-2 px-4 py-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-6")}
    >
      <div className="flex min-w-0 items-baseline gap-2">
        <span className={cardEyebrow}>No ar</span>
        <span
          className="font-mono text-[13px] font-semibold text-fg"
          title={frontier.liveSha ? `Commit publicado: ${frontier.liveSha}` : undefined}
        >
          {short(frontier.liveSha)}
        </span>
        {frontier.liveAt && (
          <span className="text-[12px] text-fg-muted">
            há <Ago iso={frontier.liveAt} bare now={now} />
          </span>
        )}
      </div>

      <div className="flex min-w-0 items-baseline gap-2 sm:flex-1">
        <span className={cardEyebrow}>Stage</span>
        <span
          className="font-mono text-[13px] font-semibold text-fg"
          title={
            frontier.stageSha
              ? `Topo do branch de staging: ${frontier.stageSha}. A promoção re-commita o delta em main, ` +
                `então as duas shas serem diferentes é normal.`
              : undefined
          }
        >
          {short(frontier.stageSha)}
        </span>
        {ahead > 0 ? (
          <span className="text-[12px] font-semibold text-accent">
            {ahead} {ahead === 1 ? "entrega ainda não no ar" : "entregas ainda não no ar"}
          </span>
        ) : (
          <span className="text-[12px] text-fg-muted">tudo publicado</span>
        )}
      </div>

      <div className="flex items-center gap-2">
        <span className={cardEyebrow}>{frontier.board}</span>
        {!frontier.canPublish ? (
          // O mecanismo inteiro está desligado (kill-switch global ou staging off) — aí não há botão a
          // oferecer, e dizer isso é melhor que um botão que só sabe recusar.
          <span className="text-[12px] text-fg-subtle" title="autorun.publishQueue.enabled / autorun.staging no settings.yaml">
            publicação indisponível
          </span>
        ) : request ? (
          <span
            className="inline-flex items-center gap-1.5 text-[12px] font-medium text-fg-muted"
            title={request.reason ?? "Na fila — publica na próxima janela de ociosidade."}
          >
            {request.status === "publishing" ? "publicando…" : "na fila"}
          </span>
        ) : (
          // O botão existe nos DOIS modos — em `auto` ele é o atalho de "vai agora, não espere o
          // produtor"; em `manual` ele É a política. Antes ele simplesmente não era renderizado num
          // board fora da lista, que é como trabalho ficava sem alavanca nenhuma.
          //
          // Ele carrega o TAMANHO e a IDADE do lote de propósito: "solta tudo de uma vez" é o padrão
          // que a literatura de entrega contínua marca como arriscado quando o acúmulo é invisível, e
          // um clique informado é a mitigação barata — quem aperta sabe quanto está soltando.
          <button
            type="button"
            onClick={onPublish}
            disabled={busy || ahead === 0}
            title={
              ahead === 0
                ? "Nada staged para publicar."
                : `Publica AS ${ahead} entrega(s) de uma vez${oldest ? `, a mais antiga de ${oldest} atrás` : ""}` +
                  ` — a promoção é do board inteiro, não por card. Acontece na próxima janela de ociosidade.` +
                  (frontier.releaseMode === "manual"
                    ? " Este board é `release.mode: manual`: nada daqui vai ao ar sem este pedido (seu, ou de um agente autônomo autorizado)."
                    : " Este board é `release.mode: auto`: o sistema também pede sozinho — isto só antecipa.")
            }
            className={cn(
              "inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[12.5px] font-semibold transition",
              ahead === 0 ? "cursor-not-allowed text-fg-subtle" : "bg-fg text-surface hover:bg-fg/85 disabled:opacity-60",
            )}
          >
            <Rocket className="h-3.5 w-3.5" />
            {ahead > 0 ? `Publicar ${ahead}` : "Publicar"}
          </button>
        )}
      </div>
    </section>
  );
}

// ── O pedido SEGURADO — a única coisa aqui que pede decisão ──────────────────────────────────────

function HeldBanner({
  req,
  busy,
  now,
  onOverride,
  onCancel,
}: {
  req: PublishRequest;
  busy: boolean;
  now: number;
  onOverride: () => void;
  onCancel: () => void;
}) {
  const blocked = isBlocked(req, now);
  // A ETA. "28 tentativas" sozinho não diz se o sistema está trabalhando ou desistiu — e era metade da
  // sensação de tela parada: nada na página revelava que existe um retry, muito menos quando.
  const proxima = until(req.nextAttemptAt, now);
  return (
    <section className="border-l-2 border-accent pl-3">
      <h2 className="mb-1.5 flex flex-wrap items-center gap-1.5 text-[13px] font-semibold tracking-tight text-fg">
        {blocked ? <ShieldAlert className="h-4 w-4 text-accent" /> : <AlertTriangle className="h-4 w-4 text-accent" />}
        Publicação segurada
        {req.heldSince && (
          <span className="font-normal text-fg-muted">
            · há <Ago iso={req.heldSince} bare now={now} />
          </span>
        )}
        {req.heldCount != null && (
          <span className="font-normal text-fg-subtle">
            · {req.heldCount} {req.heldCount === 1 ? "tentativa" : "tentativas"}
          </span>
        )}
        {proxima && (
          <span className="font-normal text-fg-subtle" title={`próxima tentativa automática: ${req.nextAttemptAt}`}>
            · tenta de novo {proxima}
          </span>
        )}
        <span className={cn(idChip, "ml-auto")}>{req.board}</span>
      </h2>

      {/* O MOTIVO, palavra por palavra como a fila o escreveu. É o texto que só existia no MCP. */}
      <p className="mb-1 max-w-[80ch] whitespace-pre-line text-[12.5px] leading-relaxed text-fg-muted">
        {req.reason ?? "Sem motivo registrado — o pedido segue esperando a janela de ociosidade."}
      </p>
      {blocked && (
        <p className="mb-2 text-[12px] text-fg-muted">
          Espera longa com contagem alta é <b className="font-semibold text-fg">bloqueio</b>, não lentidão: ou o
          trabalho sobreposto integra, ou alguém dispensa o embargo.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onOverride}
          disabled={busy}
          title="Publica ignorando a guarda de concorrência. Não destrói nada da outra sessão."
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line-emphasis px-3 text-[12.5px] font-semibold text-fg transition hover:bg-surface-hover disabled:opacity-60"
        >
          <Rocket className="h-3.5 w-3.5" />
          Publicar mesmo assim
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          title="Tira o pedido da fila. O código continua no stage."
          className="inline-flex h-8 items-center rounded-lg px-2.5 text-[12.5px] font-medium text-fg-muted transition hover:bg-surface-hover hover:text-fg disabled:opacity-60"
        >
          Cancelar pedido
        </button>
        <span className="font-mono text-[11px] text-fg-subtle" title={`id do pedido: ${req.id}`}>
          {req.id}
        </span>
      </div>
    </section>
  );
}

// ── As raias ─────────────────────────────────────────────────────────────────────────────────────

function Lane({
  label,
  count,
  icon: Icon,
  className,
  children,
}: {
  label: string;
  count?: number;
  icon: typeof Play;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={cn("flex min-w-0 flex-col gap-2", className)}>
      <h2 className="flex items-center gap-1.5 border-b border-line pb-1.5">
        <Icon className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
        <span className={cardEyebrow}>{label}</span>
        {count != null && count > 0 && <span className={cn(countChipCls, "ml-auto")}>{count}</span>}
      </h2>
      {children}
    </section>
  );
}

function LaneEmpty({ children }: { children: React.ReactNode }) {
  return <p className="px-0.5 text-[12px] text-fg-subtle">{children}</p>;
}

/** Um bloco recolhido — o que é resquício não deve custar espaço até alguém pedir. */
function Disclosure({
  label,
  tone,
  children,
}: {
  label: string;
  /** `attention` para o que tem consequência fora da própria linha (segurar publicação). */
  tone?: "attention";
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={cn(
          "inline-flex items-center gap-1 self-start rounded px-0.5 text-[11.5px] font-medium transition hover:text-fg",
          tone === "attention" ? "text-accent" : "text-fg-subtle",
        )}
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        {label}
      </button>
      {open && children}
    </div>
  );
}

/** O casco de uma linha. `tone` só existe para o que pede atenção — o resto é papel liso. */
function Row({ tone, dim, children }: { tone?: "attention"; dim?: boolean; children: React.ReactNode }) {
  return (
    <article
      className={cn(
        cardSurfaceSm,
        "flex flex-col gap-1 px-2.5 py-2",
        tone === "attention" && "border-accent/60 bg-accent/[0.06]",
        dim && "opacity-60",
      )}
    >
      {children}
    </article>
  );
}

/** O TÍTULO da linha: o que a entrega é, em palavras humanas. Sempre com tooltip — ele quebra em duas
 *  linhas e o texto inteiro precisa estar alcançável sem abrir nada. */
function RowTitle({ children, title, href }: { children: React.ReactNode; title: string; href?: string }) {
  const cls = "line-clamp-2 text-[13px] font-semibold leading-snug text-fg";
  if (!href) {
    return (
      <h3 className={cls} title={title}>
        {children}
      </h3>
    );
  }
  return (
    <h3 className="min-w-0">
      <Link href={href} title={title} className={cn(cls, "block transition hover:text-accent hover:underline")}>
        {children}
      </Link>
    </h3>
  );
}

function RowMeta({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <p className="truncate text-[11.5px] text-fg-subtle" title={title}>
      {children}
    </p>
  );
}

/** O card que este trabalho serve — a pergunta "isto é de qual card?" respondida com um LINK. */
function CardRef({ boardId, cardId, title }: { boardId: string; cardId: string; title?: string }) {
  return (
    <Link
      href={`/board/${boardId}/card/${cardId}`}
      title={title ? `${title} (${cardId})` : cardId}
      className={cn(idChip, "w-fit max-w-full transition hover:text-fg")}
    >
      {cardId}
    </Link>
  );
}

/** Um RUN do pipeline: um agente headless trabalhando um card AGORA. O estado vem do mesmo badge do
 *  Kanban — "rodando", com o tempo decorrido —, então a resposta a "está rodando ou travado?" é a
 *  MESMA nas duas telas. */
function RunRow({ run, title }: { run: RunnerRun; title?: string }) {
  const label = title ?? run.cardId;
  return (
    <Row>
      <RowTitle title={`${label} — ${run.trigger} rodando`} href={`/board/${run.board}/card/${run.cardId}`}>
        {label}
      </RowTitle>
      <div className="flex flex-wrap items-center gap-1.5">
        <RunSubstateBadge boardId={run.board} cardId={run.cardId} size="sm" />
        <span className="text-[11.5px] text-fg-subtle" title={`skill em execução: ${run.trigger}`}>
          {run.trigger}
        </span>
      </div>
      <CardRef boardId={run.board} cardId={run.cardId} title={title} />
    </Row>
  );
}

/** Uma SESSÃO de agente com worktree aberto — o trabalho que ainda não virou entrega nenhuma. */
function SessionRow({
  work,
  boardId,
  cardTitles,
  hideCard,
  dim,
  state,
  blocking,
  now,
}: {
  work: DeliveryWork;
  boardId: string;
  cardTitles: Record<string, string>;
  /** cards que JÁ aparecem como run — não repetir a mesma coisa duas vezes na raia. */
  hideCard: ReadonlySet<string>;
  dim?: boolean;
  state?: "delivered";
  /** esta sessão é uma das que SEGURAM a publicação agora (junção por `heldBy`). */
  blocking?: boolean;
  now?: number;
}) {
  const showCard = work.cardId && !hideCard.has(work.cardId);
  const devolvida = work.train && !trainIsMoving(work.train.status) && work.train.status !== "done";
  return (
    <Row tone={work.stuck || work.orphaned || blocking ? "attention" : undefined} dim={dim}>
      <RowTitle title={work.title}>{work.title}</RowTitle>
      <RowMeta
        title={
          state === "delivered"
            ? `sessão ${work.sessionId} — integrada, árvore limpa e sem sinal desde então`
            : `sessão ${work.sessionId}`
        }
      >
        {state === "delivered" ? "entregou · árvore aberta há " : "sessão · último sinal há "}
        <Ago iso={work.heartbeatAt} bare now={now} />
      </RowMeta>
      {/* O id da sessão, VISÍVEL. O banner de publicação segurada identifica o bloqueador por branch
          (`agent/<uuid>`) e a linha o identificava só pelo título da tarefa — não havia como ligar os
          dois a olho. */}
      <RowMeta title={`sessão ${work.sessionId}`}>
        <span className="font-mono">{work.sessionId.slice(0, 8)}</span>
      </RowMeta>
      {showCard && <CardRef boardId={work.board ?? boardId} cardId={work.cardId!} title={cardTitles[work.cardId!]} />}
      {blocking && (
        <RowMeta title="A promoção não publica um arquivo que esta sessão ainda tem em aberto. Ou o trabalho dela integra (worktree_submit), ou alguém dispensa o embargo no banner acima.">
          <span className="font-medium text-accent">está segurando a publicação</span>
        </RowMeta>
      )}
      {devolvida && (
        <RowMeta title={`a integração desta sessão terminou como "${TRAIN_LABEL[work.train!.status]}" — desfecho terminal: o train não vai tentar de novo sozinho`}>
          <span className="font-medium text-accent">{RETURNED_LABEL[work.train!.status] ?? "integração parada"}</span> — re-submeta
          (worktree_refresh + worktree_submit)
        </RowMeta>
      )}
      {work.orphaned && (
        <RowMeta title="A integração dela voltou para um agente que já não existe — ninguém vai agir sozinho.">
          integração órfã — ver Processos
        </RowMeta>
      )}
    </Row>
  );
}

/**
 * O que dizer na LINHA DA SESSÃO quando a integração dela voltou. Frase própria, e não o
 * {@link TRAIN_LABEL} encaixado numa sentença: aqueles rótulos são predicados do estado da ENTRADA
 * ("devolvido à sessão", masculino) e, colados depois de "integração", produziam concordância errada.
 * Aqui o sujeito é outro, então a frase é outra.
 */
const RETURNED_LABEL: Partial<Record<MergeQueueStatus, string>> = {
  "returned-to-session": "a integração voltou para você",
  failed: "a integração falhou",
};

/** Os verbos do train — os mesmos que `/processes` usa, para o operador não traduzir nada. */
const TRAIN_LABEL: Record<MergeQueueStatus, string> = {
  waiting: "na fila do train",
  "gate-running": "rodando o gate",
  merging: "integrando",
  "re-driving": "re-executando",
  "gate-failed": "gate reprovou",
  conflict: "conflito",
  "returned-to-session": "devolvido à sessão",
  failed: "falhou",
  done: "integrado",
};

function TrainRow({
  entry,
  work,
  cardTitles,
  position,
  queueLength,
  now,
}: {
  entry: MergeQueueEntry;
  work?: DeliveryWork;
  cardTitles: Record<string, string>;
  /** 1-based entre os `waiting`; 0 quando a entrada não está esperando (já está nas mãos do train). */
  position: number;
  queueLength: number;
  now?: number;
}) {
  const moving = trainIsMoving(entry.status);
  const cardTitle = entry.cardId ? cardTitles[entry.cardId] : undefined;
  const label = cardTitle ?? work?.title ?? entry.cardId ?? entry.branch;
  // O TEMPO é o que separa "está rodando" de "pendurou", e ele existia no dado desde sempre
  // (`enqueuedAt`/`mergeStartedAt`) sem nunca chegar à tela: "rodando o gate" há 2min e há 25min liam-se
  // idênticos. O gate tem timeout de 5min e a entrada, prazo de 30min — números que só ajudam se der para
  // comparar com o decorrido.
  const desde = entry.mergeStartedAt ?? entry.enqueuedAt;
  return (
    <Row tone={moving ? undefined : "attention"}>
      <RowTitle
        title={`${label} — ${TRAIN_LABEL[entry.status]}`}
        href={entry.cardId ? `/board/${entry.board}/card/${entry.cardId}` : undefined}
      >
        {label}
      </RowTitle>
      <RowMeta title={entry.pinnedSha ? `sha pinado: ${entry.pinnedSha}` : entry.branch}>
        {TRAIN_LABEL[entry.status]}
        {Number.isFinite(desde) ? ` · há ${ago(new Date(desde).toISOString(), true, now)}` : ""}
        {entry.pinnedSha ? ` · ${short(entry.pinnedSha)}` : ""}
      </RowMeta>
      {/* QUEM É O PRÓXIMO DE VERDADE. O train é serial e FIFO por chegada; sem a posição, cinco linhas
          dizendo "na fila do train" não dizem qual delas anda primeiro. */}
      {position > 0 && (
        <RowMeta title="O train integra UMA por vez, na ordem de chegada. Esta é a posição desta entrada na fila inteira (todos os boards) — é ela que serializa.">
          {position === 1 ? "próxima a integrar" : `${position}º de ${queueLength} na fila`}
        </RowMeta>
      )}
      {entry.cardId && <CardRef boardId={entry.board} cardId={entry.cardId} title={cardTitle} />}
      {!moving && (
        <Link
          href="/processes"
          title="Um gate reprovado ou um conflito espera VOCÊ — os botões de destravar ficam em Processos."
          className="text-[11.5px] font-medium text-accent hover:underline"
        >
          Destravar em Processos →
        </Link>
      )}
    </Row>
  );
}

/**
 * O texto de cada estado. Mapa EXAUSTIVO sobre `StagedState` (o `Record` faz o compilador cobrar um
 * estado novo aqui), com a decisão em `stagedState` — pura e testada — e só a prosa deste lado.
 *
 * "vai junto na próxima publicação" já foi o rótulo de TODA linha que não era o topo, inclusive em
 * board sem fila, onde não há próxima publicação nenhuma. `unscheduled` é o que faltava dizer.
 */
const STAGED_LABEL: Record<StagedState, string> = {
  held: "publicação segurada",
  queued: "na fila de publicação",
  // "pronta para publicar" nos commits que NÃO são o topo lia-se como N coisas independentes esperando,
  // cada uma com o seu botão em algum lugar. São uma só publicação: o pedido pina o TOPO e leva todo o
  // resto de carona. Os dois rótulos abaixo dizem isso.
  "head-scheduled": "a mais recente — a publicação leva daqui para trás",
  "rides-along": "vai junto na próxima publicação",
  // Board `manual`: PRONTO, não travado nem agendado. O botão está a um clique — e é isso que este
  // rótulo tem de transmitir, porque "nada agendado" sozinho lia-se como impedimento.
  "awaiting-request": "pronta — esperando o Publicar",
};

function StagedRow({
  delivery,
  work,
  request,
  isHead,
  releaseMode,
  now,
}: {
  delivery: StagedDelivery;
  work?: DeliveryWork;
  request: PublishRequest | null;
  isHead: boolean;
  releaseMode: ReleaseMode;
  now?: number;
}) {
  // O pedido só fala pelo TOPO do stage — é o sha que ele pinou. Um commit mais antigo vai junto de
  // carona, mas dizer "segurada" nele sugeriria que ele tem um pedido próprio, e não tem.
  const held = isHead && request?.status === "waiting" && !!request.heldSince;
  const label = work?.title ?? delivery.subject ?? short(delivery.sha);
  const st = stagedState({ isHead, hasRequest: !!request, held, releaseMode });
  const state = STAGED_LABEL[st];
  const why =
    st === "awaiting-request"
      ? " — este board publica sob demanda (release.mode: manual): o clique em Publicar leva esta e todas as outras de uma vez"
      : "";
  return (
    <Row tone={held ? "attention" : undefined}>
      <RowTitle title={`${label} — ${state}${why}`}>{label}</RowTitle>
      <RowMeta title={`commit ${delivery.sha}${delivery.subject ? ` — ${delivery.subject}` : ""}${why}`}>
        {state} · <Ago iso={delivery.at} bare now={now} />
      </RowMeta>
    </Row>
  );
}

function PublishedRow({ req, now }: { req: PublishRequest; now?: number }) {
  const sha = req.publishedSha ?? req.requestedSha;
  return (
    <Row>
      <RowTitle title={`Publicação ${req.id} — sha ${sha}`}>
        <span className="font-mono">{short(sha)}</span>
      </RowTitle>
      <RowMeta title={req.reason ?? `pedida por ${req.requestedBy}`}>
        {req.resolvedAt ? (
          <>
            no ar há <Ago iso={req.resolvedAt} bare now={now} />
          </>
        ) : (
          "publicado"
        )}{" "}
        · pedida por {requesterLabel(req.requestedBy)}
      </RowMeta>
    </Row>
  );
}

// ── Formatação ───────────────────────────────────────────────────────────────────────────────────

/** Quem pediu a publicação: "você" para o humano, o prefixo do id para um agente (o id inteiro fica no
 *  tooltip). Um sha sozinho não tem dono; com o dono a linha vira história de alguém. */
function requesterLabel(by: string): string {
  if (!by || by === "human") return "você";
  if (by === "agent") return "um agente";
  return `sessão ${by.slice(0, 8)}`;
}

const short = (sha: string | null | undefined): string => (sha ? sha.slice(0, 8) : "—");

/**
 * O RELÓGIO da tela. Os rótulos desta página são quase todos relativos ("há 6 min", "retenta em 12s"),
 * e sem um tique próprio eles só mudavam quando o poll de 20s trocava os dados — uma tela cujos números
 * ficam parados lê-se como travada, que é justamente a dúvida que ela existe para responder. Não faz IO;
 * o custo é um re-render. Pausa com a aba escondida, como o poll.
 */
function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = () => {
      if (typeof document === "undefined" || document.visibilityState === "visible") setNow(Date.now());
    };
    const timer = setInterval(tick, everyMs);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [everyMs]);
  return now;
}

/** Daqui a quanto tempo ("em 12s" / "em 4 min"), ou `null` quando já passou / não dá para ler. */
function until(iso: string | undefined, now: number): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso) - now;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const s = Math.round(ms / 1000);
  return s < 60 ? `em ${s}s` : `em ${Math.round(s / 60)} min`;
}

/**
 * Um instante relativo ("4 min"). É `<time>` com o instante absoluto no `dateTime` (semântico, e o
 * tooltip do navegador o mostra) e `suppressHydrationWarning` porque o TEXTO deriva do relógio: o
 * servidor o calcula num instante e o cliente hidrata em outro. É o caso que a flag existe para cobrir.
 */
function Ago({ iso, bare, now }: { iso: string; bare?: boolean; now?: number }) {
  return (
    <time dateTime={iso} title={iso} suppressHydrationWarning>
      {ago(iso, bare, now)}
    </time>
  );
}

function ago(iso: string, bare = false, now?: number): string {
  const ms = (now ?? Date.now()) - Date.parse(iso);
  if (!Number.isFinite(ms)) return bare ? "—" : "";
  const s = Math.max(0, Math.round(ms / 1000));
  const body =
    s < 60
      ? `${s}s`
      : s < 3600
        ? `${Math.floor(s / 60)} min`
        : s < 86_400
          ? `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`
          : `${Math.floor(s / 86_400)} d`;
  return bare ? body : `há ${body}`;
}
