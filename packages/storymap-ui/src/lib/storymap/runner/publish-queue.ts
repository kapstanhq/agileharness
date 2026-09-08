// A FILA DE PUBLICAÇÃO — "publique isto quando o pipeline ficar ocioso".
//
// O buraco que ela fecha: o merge train já integra trabalho SEM card (`kind: session`, ADR-065), mas a
// PUBLICAÇÃO (promote `stage`→`main` + rebuild/restart) é um efeito `onEnter` do passo `deploy` — e passo
// é coisa que CARD atravessa. Então trabalho de sessão anda até `stage` e encalha ali: ou espera o próximo
// card de outra pessoa carregá-lo de carona, ou alguém faz git na mão (a operação que já custou 130 linhas
// do engine.ts neste repo). A cadeia era `worktree → train → stage → [buraco] → main → deploy`.
//
// O que ela automatiza é o MOMENTO, nunca a DECISÃO. O pedido carrega um sha explícito: você escolhe o que
// vai ao ar, a máquina escolhe quando. Publicar exige reiniciar o serviço, e reiniciar derruba run em voo
// (guardrail never-kill) — então hoje o operador fica vigiando o runner para apertar o botão na janela
// certa. Vigiar é toil; decidir não é. O 2º toque do ADR-059 é ADIADO, não removido.
//
// AGNÓSTICA por construção (AgileHarness é OSS): nada aqui sabe o nome de um board ou de um app. O alvo do
// deploy já é derivado de `board.yaml.package` por `fireDeployBoard`; aqui só decidimos QUANDO chamar. Quem
// pode usar a fila é config (`autorun.publishQueue.enabled`, nasce DESLIGADO), não um `if` no código.

import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { runnerStateDir } from "@/lib/storymap/paths";
import { withKeyedLock } from "@/lib/storymap/serialize";
import { isBlocked } from "./delivery-view";
import type { IdleVerdict } from "./pipeline-idle";

export const PUBLISH_QUEUE_VERSION = 1;

/**
 * Estados. Os terminais existem para que NADA seja re-tentado sozinho: uma publicação re-disparada por
 * conta própria é um restart não pedido.
 */
export type PublishStatus =
  /** esperando a janela de ociosidade */
  | "waiting"
  /** o dreno pegou este pedido e está publicando AGORA */
  | "publishing"
  /** publicado (o promote rodou e o deploy foi disparado) */
  | "published"
  /** `stage` andou depois do pedido: o que iria ao ar não é mais o que você escolheu */
  | "superseded"
  /** o serviço reiniciou no meio da publicação — provavelmente o próprio deploy (ver reapInterrupted) */
  | "interrupted"
  /** o promote/deploy falhou; `reason` diz por quê */
  | "failed"
  /** cancelado por humano/agente */
  | "cancelled";

/** Estados que ainda podem mudar sozinhos. O resto é história. */
const OPEN: ReadonlySet<PublishStatus> = new Set<PublishStatus>(["waiting", "publishing"]);

export interface PublishRequest {
  id: string;
  board: string;
  /** o sha de `stage` que o solicitante VIU e escolheu publicar. */
  requestedSha: string;
  /** quem pediu (sessionId do agente, ou "human") — trilha de auditoria. */
  requestedBy: string;
  requestedAt: string;
  /**
   * Aceitar publicar mesmo que `stage` tenha andado desde o pedido. DEFAULT false: numa `stage`
   * COMPARTILHADA, publicar "o que estiver lá" pode levar ao ar o refactor meio-pronto que outra sessão
   * empurrou há cinco minutos. Falso ⇒ o pedido vira `superseded` e volta para quem pediu decidir.
   */
  allowNewer: boolean;
  /**
   * Dispensa a guarda de concorrência (`concurrent-work`) DESTA publicação. DEFAULT false: a guarda existe
   * porque publicar um arquivo que outra sessão está reescrevendo cria divergência silenciosa. Mas ela era
   * a única recusa do sistema SEM saída — e uma sessão sobreposta que não integra deixava o board incapaz
   * de publicar (medido 2026-07-27). Ligar isto é decisão humana explícita e fica no registro.
   */
  overrideEmbargo?: boolean;
  status: PublishStatus;
  /**
   * POR QUE está como está. Preenchido também enquanto `waiting`: um pedido SEGURADO (`concurrent-work`)
   * precisa dizer isso na superfície do operador — antes o adiamento LIMPAVA o motivo e o `publish_status`
   * mostrava um `waiting` mudo, obrigando a caçar a causa no journalctl (2026-07-27).
   */
  reason?: string;
  /** Só de desfecho TERMINAL. Um pedido que segue esperando não tem "resolvedAt" — ver o patch de adiamento. */
  resolvedAt?: string;
  /** Desde quando este pedido está sendo segurado (1º adiamento). Some quando ele publica/resolve. */
  heldSince?: string;
  /** Quantas vezes foi adiado — "segurado há 40min, 160 tentativas" lê-se como travado, não como lento. */
  heldCount?: number;
  /**
   * QUEM está segurando, estruturado (o `owner` de cada colisão: `agent/<sessionId>`, `fila:<runId>`, ou a
   * descrição de uma sessão adotada). O `reason` já os nomeia em prosa, mas prosa não é chave de junção: a
   * Entrega usa isto para APONTAR a linha do bloqueador — sem ele, ligar banner e linha exigiria procurar
   * um uuid dentro de uma frase, que quebra calada no dia em que alguém reescrever o texto.
   */
  heldBy?: string[];
  /**
   * QUANDO o dreno vai tentar de novo (ISO). Sem isto, "33 tentativas" é um número sem eixo: o operador
   * não tem como distinguir "retenta em 15s" de "retenta daqui a 10min" e a tela parece parada mesmo com o
   * sistema trabalhando. Quem estampa é o CHAMADOR do dreno (`DrainDeps.retryEtaMs`), porque é ele que
   * tem os timers — a fila não inventa cronograma, só registra o que lhe foi dito.
   */
  nextAttemptAt?: string;
  /** o sha de `stage` que efetivamente foi publicado. */
  publishedSha?: string;
}

export interface PublishQueueStore {
  load(): Promise<PublishRequest[]>;
  persist(rows: PublishRequest[]): Promise<void>;
}

// ── Núcleo PURO (sem disco, sem git) — o que dá para testar sem subir nada ────────────────────────

/**
 * O que fazer com um pedido, dado o estado do mundo. Separado da execução porque a DECISÃO é a parte
 * sutil (sha andou? board ligado?) e a execução é só "chame o efeito canônico".
 */
export type PublishDecision =
  | { action: "publish"; sha: string }
  | { action: "supersede"; reason: string }
  | { action: "hold"; reason: string };

/**
 * Decide UM pedido. `stageSha` é o sha atual do branch de staging do board.
 *
 * A comparação com `requestedSha` é o que preserva "você escolhe o que vai ao ar": se `stage` andou, o
 * conteúdo mudou desde que o humano olhou, e publicar seria entregar uma coisa por outra.
 */
export function decidePublish(
  req: PublishRequest,
  ctx: { stageSha: string | null; boardEnabled: boolean },
): PublishDecision {
  if (!ctx.boardEnabled) {
    return { action: "hold", reason: `a fila de publicação está desligada para o board "${req.board}"` };
  }
  if (!ctx.stageSha) {
    return { action: "hold", reason: "não deu para ler o sha do branch de staging" };
  }
  if (ctx.stageSha !== req.requestedSha && !req.allowNewer) {
    return {
      action: "supersede",
      reason:
        `o branch de staging andou desde o pedido (pedido ${short(req.requestedSha)}, agora ${short(ctx.stageSha)}) — ` +
        `o que iria ao ar não é mais o que você escolheu. Re-submeta olhando o novo estado, ou peça com allowNewer.`,
    };
  }
  return { action: "publish", sha: ctx.stageSha };
}

/**
 * Um pedido `publishing` encontrado NO BOOT é resquício de um restart no meio da publicação — quase sempre
 * o PRÓPRIO deploy, que reinicia o serviço (`fireDeployBoard`) enquanto este processo o aguardava.
 *
 * Vira `interrupted`, que é TERMINAL, e nunca `waiting`. Essa é a trava contra o pior modo de falha desta
 * feature: re-enfileirar sozinho faria o boot republicar, que reinicia, que reencontra o pedido — um laço
 * de deploy que ninguém pediu. Se a publicação de fato não terminou, o humano re-submete; um restart a
 * menos é sempre mais barato que um laço de restarts.
 *
 * ⚠️ SÓ NO BOOT — e isto é correção de um defeito real. Ela rodava dentro de `store.load()`, "para a trava
 * valer para QUALQUER leitor". O efeito colateral: enquanto uma publicação legítima está EM VOO, todo
 * leitor (a página de Entrega, o `publish_status`, o próprio dreno) via `interrupted` + "o serviço
 * reiniciou durante a publicação" — uma afirmação FALSA, apresentada como desfecho terminal, sobre um
 * pedido que estava indo bem. Pior: como o `load` não persistia, a mentira ia e voltava a cada leitura.
 * A trava real nunca foi esta função — é {@link nextWaiting}, que só coleta `waiting`: um `publishing`
 * esquecido no disco jamais é re-publicado, com ou sem reap. Hoje o reap é uma TRANSIÇÃO de verdade
 * ({@link reapInterruptedAtBoot}, que persiste), e `load()` devolve o que está no disco.
 */
export function reapInterrupted(rows: PublishRequest[], now: string): PublishRequest[] {
  return rows.map((r) =>
    r.status === "publishing"
      ? {
          ...r,
          status: "interrupted" as const,
          resolvedAt: now,
          reason:
            "o serviço reiniciou durante a publicação (provavelmente o próprio deploy). NÃO re-tentado " +
            "automaticamente: confira se o código subiu e re-submeta se precisar.",
        }
      : r,
  );
}

/** O próximo pedido a drenar: o mais ANTIGO em espera (FIFO — quem pediu primeiro publica primeiro). */
export function nextWaiting(rows: PublishRequest[], board?: string): PublishRequest | null {
  const waiting = rows.filter((r) => r.status === "waiting" && (!board || r.board === board));
  if (!waiting.length) return null;
  return waiting.reduce((a, b) => (a.requestedAt <= b.requestedAt ? a : b));
}

/** Como {@link nextWaiting}, mas ignorando ids JÁ examinados neste tick (hold/adiamento) — para o dreno
 *  em loop não voltar eternamente ao mesmo pedido que segue `waiting`. */
function nextWaitingExcept(rows: PublishRequest[], skip: ReadonlySet<string>): PublishRequest | null {
  const waiting = rows.filter((r) => r.status === "waiting" && !skip.has(r.id));
  if (!waiting.length) return null;
  return waiting.reduce((a, b) => (a.requestedAt <= b.requestedAt ? a : b));
}

/** Já existe pedido ABERTO para este board+sha? Torna o enqueue idempotente (re-pedir não empilha). */
export function findOpenDuplicate(rows: PublishRequest[], board: string, sha: string): PublishRequest | null {
  return rows.find((r) => OPEN.has(r.status) && r.board === board && r.requestedSha === sha) ?? null;
}

/**
 * Os pedidos abertos do MESMO board que o pedido de `sha` acabou de tornar obsoletos.
 *
 * Um board tem UM `stage`: dois pedidos abertos para shas diferentes são duas fotos do mesmo lugar, e a
 * mais nova é a que alguém olhou. A antiga já estava condenada — `decidePublish` a superseda assim que o
 * dreno chegar nela ("o branch de staging andou desde o pedido") —, então antecipar o veredito no enqueue
 * não muda NENHUMA decisão: só a entrega na hora certa, em vez de daqui a um tick esparso.
 *
 * Por que importa: sem isto os pedidos EMPILHAM. `findOpenDuplicate` deduplica por (board, sha), então
 * cada `worktree_submit` seguido de `publish_when_idle` acrescenta mais um — e a Entrega renderiza um
 * banner "Publicação segurada" por pedido. Medido em 2026-07-28: dois banners idênticos na tela, ambos
 * condenados, nenhum publicável.
 *
 * `allowNewer` é a EXCEÇÃO e por isso está no predicado: esse pedido não pede um sha, pede "o que estiver
 * lá quando der" — ele não fica obsoleto porque o stage andou. Supersedê-lo seria revogar uma escolha
 * explícita. `publishing` também fica de fora: reescrever um pedido em voo é corrida, não limpeza.
 */
export function stalePeers(rows: PublishRequest[], board: string, sha: string): PublishRequest[] {
  return rows.filter(
    (r) => r.status === "waiting" && r.board === board && r.requestedSha !== sha && !r.allowNewer,
  );
}

const short = (sha: string) => sha.slice(0, 8);

// ── O DRENO (efeitos injetados) ──────────────────────────────────────────────────────────────────

export interface DrainDeps {
  store: PublishQueueStore;
  /** o pipeline está ocioso? (runner/pipeline-idle — a MESMA régua do recovery sweep) */
  idle: () => Promise<IdleVerdict>;
  /** sha atual do branch de staging do board. */
  stageSha: (board: string) => Promise<string | null>;
  /** a fila está ligada para este board? (config — nunca um `if (board === ...)`) */
  boardEnabled: (board: string) => boolean;
  /** o efeito CANÔNICO de publicação (runner/entry-effects `firePromoteAndDeploy`). Recebe o
   *  `excludeSessionId` = quem PEDIU (a sessão dona do trabalho staged): a sonda de concorrência tem de
   *  ignorá-la, senão a publicação feita de dentro da própria sessão se auto-bloqueia para sempre. E
   *  `overrideEmbargo`, a válvula de escape do pedido (ver PublishRequest.overrideEmbargo). */
  publish: (
    board: string,
    excludeSessionId?: string,
    opts?: { overrideEmbargo?: boolean },
  ) => Promise<PublishEffect>;
  /**
   * Em quantos ms este chamador vai tentar de novo. Vira `nextAttemptAt` em todo pedido que ficar
   * `waiting` — é o que transforma "33 tentativas" (um número sem eixo) em "retenta em 15s". Mora no
   * CHAMADOR porque é ele que tem os timers (retry curto × sweep esparso); a fila não inventa cronograma.
   * Ausente/undefined ⇒ o campo não é estampado (nem mentido).
   */
  retryEtaMs?: () => number | undefined;
  /**
   * Chamado UMA VEZ, na borda em que um pedido passa a contar como BLOQUEADO ({@link isBlocked}) — não a
   * cada adiamento. Existe porque a espera longa era invisível fora da página: o operador só descobria as
   * 33 tentativas se abrisse a Entrega. Injetado (e não um import do barramento de avisos) porque este
   * módulo é agnóstico por construção — ver o cabeçalho.
   */
  onBlocked?: (req: PublishRequest) => void;
  now?: () => string;
}

/**
 * O que a publicação REALMENTE fez. Existe porque `publish` era `Promise<void>`: o dreno só sabia se
 * ela tinha LANÇADO, e `firePromoteAndDeploy` não lança — ele loga e volta. Resultado observado em
 * 2026-07-23: o promote recusou (`concurrent-work`, sessão viva nos mesmos arquivos), o deploy foi
 * suprimido, e o pedido foi carimbado `published` assim mesmo. Um "No Ar" mentiroso na fila, a mesma
 * doença que o board já tinha combatido nos cards.
 *
 * `landed` é a única coisa que autoriza o carimbo `published`; `deferred` separa "não deu agora, tente
 * depois" de "quebrou".
 */
export interface PublishEffect {
  /** o código ESTÁ em main — promovido agora, ou já estava (no-op idempotente). */
  landed: boolean;
  /**
   * Não está em main, mas nada quebrou nem se perdeu — dá para tentar no próximo tick. É o caso do
   * `concurrent-work`, cujo próprio comentário promete "ele volta e publica depois": isso valia para o
   * card (que reabre) e NUNCA para a fila, que já tinha carimbado terminal.
   */
  deferred: boolean;
  reason?: string;
  /** Quem segurou (donos estruturados, de `ReleaseOutcome.heldBy`) — ver `PublishRequest.heldBy`. */
  heldBy?: string[];
}

export type DrainOutcome =
  | { status: "empty" }
  | { status: "skipped-busy"; blockedBy: string | null }
  | { status: "held"; id: string; reason: string }
  | { status: "superseded"; id: string; reason: string }
  | { status: "published"; id: string; sha: string }
  | { status: "failed"; id: string; reason: string };

/**
 * O desfecho é ADIADO/TRANSITÓRIO? — o trabalho AINDA quer publicar, mas não pôde AGORA: `skipped-busy`
 * (o pipeline estava ASSENTANDO — a sonda de ociosidade recusou) ou `held` (segurado por algo que logo
 * passa: toggle, git ilegível, ou `concurrent-work` de uma sessão que está integrando). Nesses casos o
 * chamador deve RE-DISPARAR o dreno em segundos, em vez de esperar o próximo tick esparso do sweep
 * (medido 2026-07-24: até ~10min de espera pura DEPOIS de o trabalho já ter ficado publicável — o gatilho
 * fino disparou cedo demais e nada re-tentou). NÃO adia: `empty` (fila vazia) e os resolvidos
 * `published`/`superseded`/`failed`. Puro → testável sem subir serviço nem timer.
 */
export function drainDeferred(outcome: DrainOutcome | null | undefined): boolean {
  return outcome?.status === "skipped-busy" || outcome?.status === "held";
}

/** Impede dois drenos simultâneos no mesmo processo (o hook on-idle e o timer periódico podem coincidir). */
let draining = false;

/**
 * Publica NO MÁXIMO UM pedido por chamada — publicar reinicia o serviço, então o 2º morreria no meio de
 * qualquer forma; ele fica `waiting`, honesto, para o próximo tick. MAS os pedidos que não publicam agora
 * — `supersede` (staging andou) e `hold`/adiamento (board desligado, git ilegível, `concurrent-work`) —
 * são resolvidos ou pulados NO MESMO tick, para nenhum deles SEGURAR um pedido mais novo (de qualquer
 * board) atrás de si na FIFO.
 *
 * Conserta o head-of-line (2026-07-24): antes o dreno olhava só `nextWaiting` (o mais antigo de QUALQUER
 * board) e voltava — um pedido no topo que precisa de um tick para supersedar segurava todos os outros, e
 * como os ticks são esparsos (on-idle / on-settle / sweep ~10min) um `publish_when_idle` novo esperava
 * um pedido alheio ser resolvido antes de ser sequer olhado (medido: ~8min de espera pura num board OCIOSO).
 */
export async function drainPublishQueue(deps: DrainDeps): Promise<DrainOutcome> {
  if (draining) return { status: "skipped-busy", blockedBy: "outro dreno em andamento" };
  draining = true;
  const now = deps.now ?? (() => new Date().toISOString());
  try {
    let rows = await deps.store.load();
    if (!nextWaiting(rows)) return { status: "empty" };

    // A ociosidade é checada DEPOIS de saber que há trabalho: sem pedido, nem vale perguntar.
    const verdict = await deps.idle();
    if (!verdict.idle) return { status: "skipped-busy", blockedBy: verdict.blockedBy };

    // `skip` = os pedidos já examinados que continuam `waiting` (hold / adiamento) — sem ele `nextWaiting`
    // devolveria o mesmo eternamente. `last` guarda o desfecho a reportar quando NADA publica (o mais
    // recente supersede/held). O guard é rede contra qualquer laço acidental; a fila real nunca chega perto.
    const skip = new Set<string>();
    let last: DrainOutcome = { status: "empty" };
    for (let guard = 0; guard < 1000; guard++) {
      const pending = nextWaitingExcept(rows, skip);
      if (!pending) return last;

      const sha = await deps.stageSha(pending.board).catch(() => null);
      const decision = decidePublish(pending, { stageSha: sha, boardEnabled: deps.boardEnabled(pending.board) });

      if (decision.action === "hold") {
        // Transitório (toggle desligado, git ilegível): segue `waiting` para o próximo tick, e PULA (skip)
        // para não travar os pedidos atrás dele. O MOTIVO é gravado — pelo mesmo princípio do adiamento
        // abaixo: um pedido segurado tem de dizer por quê na superfície do operador. A ETA é reestampada
        // sempre (ela ENVELHECE: um `nextAttemptAt` no passado é pior que nenhum), o resto só quando muda.
        const eta = nextAttempt(deps, now);
        if (pending.reason !== decision.reason || pending.nextAttemptAt !== eta) {
          await patch(deps.store, rows, pending.id, {
            reason: decision.reason,
            resolvedAt: undefined,
            heldSince: pending.heldSince ?? now(),
            nextAttemptAt: eta,
          });
          rows = await deps.store.load();
        }
        skip.add(pending.id);
        last = { status: "held", id: pending.id, reason: decision.reason };
        continue;
      }
      if (decision.action === "supersede") {
        await patch(deps.store, rows, pending.id, { status: "superseded", reason: decision.reason, resolvedAt: now() });
        rows = await deps.store.load();
        last = { status: "superseded", id: pending.id, reason: decision.reason };
        continue;
      }

      // decision.action === "publish" — o ÚNICO que reinicia o serviço: faz UM e RETORNA.
      // Marca `publishing` ANTES de agir: se o restart nos matar no meio, o load seguinte encontra o
      // marcador e o converte em `interrupted` (terminal) em vez de re-publicar sozinho.
      await patch(deps.store, rows, pending.id, { status: "publishing" });
      let effect: PublishEffect;
      try {
        // Passa quem PEDIU: a promoção exclui essa sessão da sonda de concorrência (o trabalho dela já está
        // em stage — é o que estamos promovendo). Sem isto, uma sessão que publica o PRÓPRIO trabalho conta
        // como "trabalho vivo nos mesmos arquivos" e o promote adia para sempre (`concurrent-work`).
        effect = await deps.publish(pending.board, pending.requestedBy, {
          overrideEmbargo: pending.overrideEmbargo,
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        await patch(deps.store, await deps.store.load(), pending.id, { status: "failed", reason, resolvedAt: now() });
        return { status: "failed", id: pending.id, reason };
      }

      // O carimbo `published` exige que o código tenha ATERRISSADO. Antes bastava não lançar — e como
      // `firePromoteAndDeploy` loga a falha em vez de lançar, um promote recusado virava "publicado".
      if (!effect.landed) {
        const reason = effect.reason ?? "a promoção não colocou o código em main";
        if (effect.deferred) {
          // `concurrent-work`: adiamento, não defeito. Volta para `waiting` e PULA — talvez OUTRO board
          // publique agora (mais um ganho do loop: um board bloqueado por concorrência não segura os demais).
          // O motivo do ADIAMENTO fica GRAVADO (`reason`): é o que o operador lê no publish_status e na
          // Entrega. Ele já foi zerado aqui um dia, e o resultado era um pedido segurado MUDO — `waiting`,
          // sem causa, indistinguível de um recém-enfileirado. `resolvedAt: undefined` porque um pedido que
          // continua esperando NÃO está resolvido, e o campo mentiria na superfície.
          const held = await deps.store.load();
          const prev = held.find((r) => r.id === pending.id);
          const updated: PublishRequest = {
            ...(prev ?? pending),
            status: "waiting",
            reason,
            resolvedAt: undefined,
            heldSince: prev?.heldSince ?? now(),
            heldCount: (prev?.heldCount ?? 0) + 1,
            nextAttemptAt: nextAttempt(deps, now),
            heldBy: effect.heldBy,
          };
          await patch(deps.store, held, pending.id, updated);
          // A BORDA para bloqueado — dispara UMA vez, na transição. Sem isto a espera longa só existia para
          // quem abrisse a página: 33 tentativas em silêncio (2026-07-28). O `at` da régua é o mesmo `now`
          // do patch, então a comparação antes/depois é sobre o mesmo instante.
          //
          // O "antes" é `pending`, NUNCA `prev`: `prev` é a releitura da nossa própria linha DEPOIS do
          // carimbo `publishing` desta tentativa, e `isBlocked` só reconhece `waiting` — então ele nunca
          // parece bloqueado e o aviso dispararia a cada adiamento, que é exatamente o volume que este
          // aviso existe para não produzir. `pending` é a linha como ela estava ao ser escolhida.
          const at = Date.parse(now());
          if (deps.onBlocked && !isBlocked(pending, at) && isBlocked(updated, at)) {
            try {
              deps.onBlocked(updated);
            } catch (err) {
              console.warn("[harness-publish] aviso de bloqueio falhou:", err instanceof Error ? err.message : err);
            }
          }
          rows = await deps.store.load();
          skip.add(pending.id);
          last = { status: "held", id: pending.id, reason };
          continue;
        }
        await patch(deps.store, await deps.store.load(), pending.id, { status: "failed", reason, resolvedAt: now() });
        return { status: "failed", id: pending.id, reason };
      }

      // `reason: effect.reason` sobrescreve DETERMINISTICAMENTE — é o motivo REAL do efeito (ausente num
      // promote fresco → limpa; "already-promoted" num no-op idempotente → informativo). Um pedido que
      // PUBLICOU não pode carregar o texto de uma espera anterior: 12/12 dos `published` já leram como
      // falha por herdarem o motivo de "interrompido" que o reap de leitura estampava.
      // `heldSince`/`heldCount`/`nextAttemptAt` são zerados junto: são campos de ESPERA, e a espera acabou —
      // deixá-los sugeriria, na Entrega, uma publicação que ainda está sendo segurada.
      await patch(deps.store, await deps.store.load(), pending.id, {
        status: "published",
        publishedSha: decision.sha,
        resolvedAt: now(),
        reason: effect.reason,
        heldSince: undefined,
        heldCount: undefined,
        nextAttemptAt: undefined,
        heldBy: undefined,
      });
      return { status: "published", id: pending.id, sha: decision.sha };
    }
    return last;
  } finally {
    draining = false;
  }
}

async function patch(
  store: PublishQueueStore,
  rows: PublishRequest[],
  id: string,
  fields: Partial<PublishRequest>,
): Promise<void> {
  await store.persist(rows.map((r) => (r.id === id ? { ...r, ...fields } : r)));
}

/**
 * Quando o chamador vai bater na porta de novo, em ISO — ou `undefined` quando ele não sabe dizer (e aí o
 * campo simplesmente não existe: prometer uma hora que ninguém vai cumprir é pior que não prometer).
 */
function nextAttempt(deps: DrainDeps, now: () => string): string | undefined {
  const ms = deps.retryEtaMs?.();
  if (ms == null || !Number.isFinite(ms) || ms < 0) return undefined;
  return new Date(Date.parse(now()) + ms).toISOString();
}

// ── Store em disco + a API pública (enqueue/list/cancel) ─────────────────────────────────────────

/**
 * Store atômico: escreve um temp e renomeia por cima (o mesmo padrão do journal/claims). O `reapInterrupted`
 * roda no LOAD, não num boot-hook: assim a trava contra o laço de deploy vale para QUALQUER leitor, inclusive
 * um que suba fora do caminho de boot.
 */
export function diskPublishQueueStore(dir: string): PublishQueueStore {
  const file = path.join(dir, "publish-queue.json");
  const tmp = `${file}.tmp`;
  return {
    async load() {
      let raw: string;
      try {
        raw = await fsp.readFile(file, "utf8");
      } catch (err) {
        // Arquivo ausente é o cold start normal (silencioso); o resto avisa e degrada para vazio.
        if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
          console.warn("[harness-publish] load falhou — degradando p/ vazio:", err instanceof Error ? err.message : err);
        }
        return [];
      }
      let rows: PublishRequest[];
      try {
        const parsed = JSON.parse(raw) as { entries?: PublishRequest[] };
        rows = Array.isArray(parsed.entries) ? parsed.entries.filter(isWellFormed) : [];
      } catch (err) {
        console.warn("[harness-publish] arquivo corrompido — degradando p/ vazio:", err instanceof Error ? err.message : err);
        return [];
      }
      return rows;
    },
    async persist(rows) {
      await fsp.mkdir(dir, { recursive: true });
      const body = JSON.stringify({ v: PUBLISH_QUEUE_VERSION, entries: rows }, null, 2);
      try {
        await fsp.writeFile(tmp, body, "utf8");
        await fsp.rename(tmp, file);
      } catch {
        await fsp.writeFile(file, body, "utf8");
      }
    },
  };
}

/** Descarta entrada malformada em vez de deixá-la derrubar a fila inteira (per-entry, como o journal). */
function isWellFormed(r: unknown): r is PublishRequest {
  const x = r as PublishRequest;
  return !!x && typeof x.id === "string" && typeof x.board === "string" && typeof x.status === "string";
}

/** O store default (storymap/.runner/publish-queue.json). */
export function defaultPublishQueueStore(): PublishQueueStore {
  return diskPublishQueueStore(runnerStateDir());
}

/**
 * A TRANSIÇÃO de boot: converte todo `publishing` órfão em `interrupted` e PERSISTE. Chamada uma vez pelo
 * `instrumentation` antes de armar o dreno — ver a nota em {@link reapInterrupted} sobre por que isto
 * deixou de acontecer a cada leitura. Idempotente (sem `publishing`, não escreve) e nunca lança: uma
 * varredura de boot que derruba o boot seria pior que o resquício que ela limpa.
 */
export async function reapInterruptedAtBoot(store?: PublishQueueStore): Promise<number> {
  const s = store ?? defaultPublishQueueStore();
  try {
    const rows = await s.load();
    const orphans = rows.filter((r) => r.status === "publishing");
    if (orphans.length === 0) return 0;
    await s.persist(reapInterrupted(rows, new Date().toISOString()));
    return orphans.length;
  } catch (err) {
    console.warn("[harness-publish] reap de boot falhou:", err instanceof Error ? err.message : err);
    return 0;
  }
}

// ── Nudge do dreno NO ENQUEUE — fecha a lacuna "já-ocioso" ──────────────────────────────────────────
//
// O dreno da fila (instrumentation) é disparado por `engine.onIdle` (o INSTANTE em que o engine esvazia)
// + um timer periódico de rede-de-segurança (~10min). Mas um `publish_when_idle` pedido com o pipeline
// JÁ ocioso não gera transição nenhuma → o `onIdle` não dispara, e o pedido espera ATÉ um intervalo
// inteiro do timer (medido 2026-07-24: ~8min de espera pura, justamente quando o sistema está MAIS
// ocioso — a hora ideal de publicar). O enqueue é ELE PRÓPRIO um evento: nudgiamos o dreno aqui.
// `instrumentation` registra o gatilho real no boot; sem serviço (testes/CLI) é no-op seguro. É idempotente
// e idle-gated no dreno (guarda contra concorrência + `pipelineIdle`), então um nudge a mais nunca faz mal.
let drainNudge: (() => void) | null = null;
export function registerPublishDrainTrigger(fn: () => void): void {
  drainNudge = fn;
}
export function nudgePublishDrain(): void {
  drainNudge?.();
}

/**
 * Enfileira um pedido. IDEMPOTENTE por (board, sha): re-pedir a mesma publicação devolve o pedido que já
 * está aberto em vez de empilhar dois — um agente que re-tenta não pode gerar dois deploys. Um pedido
 * NOVO resolve na mesma escrita os pedidos abertos que ele torna obsoletos (ver {@link stalePeers}), para
 * a fila de um board nunca acumular fotos condenadas. Ao final, NUDGIA o dreno (fora do lock): um pedido
 * enfileirado com o pipeline já ocioso publica AGORA, sem esperar o timer periódico.
 */
export async function enqueuePublish(input: {
  board: string;
  requestedSha: string;
  requestedBy: string;
  allowNewer?: boolean;
  overrideEmbargo?: boolean;
  store?: PublishQueueStore;
  now?: () => string;
}): Promise<{ request: PublishRequest; deduped: boolean; superseded?: string[] }> {
  const store = input.store ?? defaultPublishQueueStore();
  const now = input.now ?? (() => new Date().toISOString());
  const result = await withKeyedLock("publish-queue", async () => {
    const rows = await store.load();
    const dup = findOpenDuplicate(rows, input.board, input.requestedSha);
    if (dup) {
      // ELEVA as permissões do pedido já aberto em vez de devolvê-lo intacto. Sem isto a válvula de escape
      // seria INALCANÇÁVEL exatamente quando é necessária: o pedido que está travado JÁ existe, então um
      // `publish_when_idle({overrideEmbargo:true})` casaria com o duplicado e devolveria a linha antiga —
      // sem override, seguindo travada. Só sobe (false→true), nunca desce: re-pedir sem os flags não pode
      // silenciosamente REVOGAR uma dispensa que alguém concedeu de propósito.
      const upgrade: Partial<PublishRequest> = {};
      if (input.allowNewer && !dup.allowNewer) upgrade.allowNewer = true;
      if (input.overrideEmbargo && !dup.overrideEmbargo) upgrade.overrideEmbargo = true;
      if (Object.keys(upgrade).length === 0) return { request: dup, deduped: true };
      const upgraded = { ...dup, ...upgrade };
      await store.persist(rows.map((r) => (r.id === dup.id ? upgraded : r)));
      return { request: upgraded, deduped: true };
    }
    const request: PublishRequest = {
      id: `pub-${randomUUID()}`,
      board: input.board,
      requestedSha: input.requestedSha,
      requestedBy: input.requestedBy,
      requestedAt: now(),
      allowNewer: input.allowNewer ?? false,
      ...(input.overrideEmbargo ? { overrideEmbargo: true } : {}),
      status: "waiting",
    };
    // Este pedido é a foto mais nova do stage deste board — os pedidos abertos de shas antigos já estão
    // condenados (ver `stalePeers`). Resolvê-los AQUI, na mesma escrita, é o que impede a pilha de banners
    // condenados na Entrega. O texto nomeia o pedido que os substituiu, para a trilha ficar legível.
    const stale = new Set(stalePeers(rows, input.board, input.requestedSha).map((r) => r.id));
    const at = now();
    const kept = rows.map((r) =>
      stale.has(r.id)
        ? {
            ...r,
            status: "superseded" as const,
            resolvedAt: at,
            reason:
              `substituído pelo pedido ${request.id} (${short(input.requestedSha)}), mais novo, do mesmo board — ` +
              `o que iria ao ar não é mais o que você escolheu. Nada foi perdido: o código segue no stage.`,
          }
        : r,
    );
    await store.persist([...kept, request]);
    return { request, deduped: false, superseded: [...stale] };
  });
  // FORA do lock (persist concluído, lock liberado): o dreno lê o store fresco e enxerga o pedido novo.
  // Fire-and-forget — o gatilho registrado já faz `void drainTick()`. Nudgiar TAMBÉM no dedup deixa o
  // operador "re-cutucar" um pedido encalhado só re-chamando publish_when_idle.
  nudgePublishDrain();
  return result;
}

/** Todos os pedidos, mais novos primeiro. */
export async function listPublishRequests(store?: PublishQueueStore): Promise<PublishRequest[]> {
  const rows = await (store ?? defaultPublishQueueStore()).load();
  return [...rows].sort((a, b) => (a.requestedAt < b.requestedAt ? 1 : -1));
}

/** Cancela um pedido que ainda espera. Um já resolvido não muda (história não se reescreve). */
export async function cancelPublish(
  id: string,
  opts: { store?: PublishQueueStore; reason?: string; now?: () => string } = {},
): Promise<PublishRequest | null> {
  const store = opts.store ?? defaultPublishQueueStore();
  const now = opts.now ?? (() => new Date().toISOString());
  return withKeyedLock("publish-queue", async () => {
    const rows = await store.load();
    const target = rows.find((r) => r.id === id);
    if (!target || target.status !== "waiting") return null;
    const updated: PublishRequest = {
      ...target,
      status: "cancelled",
      resolvedAt: now(),
      ...(opts.reason ? { reason: opts.reason } : {}),
    };
    await store.persist(rows.map((r) => (r.id === id ? updated : r)));
    return updated;
  });
}
