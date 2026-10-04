// HITL "pending demands" — the SINGLE source of truth for everything that needs the human
// orchestrator, PURE (no IO, no React), analogous to openQuestions(). It is the keystone that fixes
// the fragmentation root cause: today ~14 distinct human demands are scattered across 3 disconnected
// surfaces (drag on the Kanban, buttons inside a card drawer, buttons in /processes) and the
// notification layer is blind to all of them (it only fans out generic card lifecycle events). With
// ONE derivation, the three consumers — the aggregated "Central de Ações / Precisa de você" screen,
// the top-nav demand badge/center, and the web-push channel — all read the SAME state instead of
// each re-inferring it.
//
// SCOPE: this module derives the demands that live ON A CARD (open questions, open blocker findings,
// low-confidence triage, and the human GATE a card rests at). Merge-train demands (conflict /
// gate-failed) live on the merge QUEUE, not the card, so the board-level aggregator folds those in
// from the queue snapshot — see `mergeQueueDemands` below.

import { openQuestions } from "./questions";
import { effectiveQuestionCategory, isOwnerDecisionQuestion, isPendingProxyAudit, isProxiableQuestion } from "./autonomy";
import { cardOwnerClass, isBusinessOnly } from "./decision-class";
import { ownerClassLabel } from "./owner-classes";
import { deliveryBeforeAfterOf, deliveryProofOf, isDeliveryApprovalStep, isPendingDeliveryAudit } from "./delivery-audit";
import { draftTitle, isGovernanceDraftStale } from "./governance";
import { hasCanvasContent } from "./design-canvas";
// type-only: apagado em runtime, então não cria ciclo (copilot/tier.ts não importa demands.ts) e mantém este
// módulo puro. O TIER é a projeção canônica de (mode, riskMatrix.deploy) — ver copilot/tier.ts.
import type { CopilotTier } from "./copilot/tier";
import type { BoardConfig, Card, DesignArtifact, DesignFeedbackEntry, EntryEffect, FailureClass, FindingSeverity, GovernanceChange, GovernanceDraft, QuestionCategory, QuestionMode, QuestionOption, RiskClass, StatusDef, WireframeDoc, WireframeJourney, WireframeOption } from "./types";
import type { ProposalDoc, ProposedItem } from "./smart-capture/types";
import type { RunnerFailure } from "./runner/types";
import type { MergeQueueSnapshot } from "./runner/types";
import type { EntryResolutionAnalysis } from "./resolution-analysis";

/** F8 — id estável do finding que um deploy de produção falho carimba no card (deploy-revert.ts UPSERTA por
 *  este id). Mora AQUI, no módulo puro, porque quem precisa dele são as duas pontas: o servidor que o ESCREVE
 *  e a derivação de demanda (client-safe) que o LÊ. deploy-revert.ts re-exporta para os importadores antigos. */
export const DEPLOY_FAILURE_FINDING_ID = "deploy-failure";
/**
 * O settle do deploy CHEGOU OK, mas não PROVOU que o código deste card está no ar — o card segue em Publicar
 * (um alvo pode provar depois, ex.: a face encadeada) e o MOTIVO fica no card por este finding (título, motivo
 * em português + o código, e o conserto). Sem ele o motivo só existia no log do serviço, e o Inbox pintava o
 * card parado como «espera sua aprovação» sem nada para aprovar. Escrito/resolvido
 * SÓ pelo settle (deploy-reconcile `applyDeploySettleSuccess`); projetado no item `deploy-unsettled` (`held`).
 */
export const DEPLOY_UNPROVEN_FINDING_ID = "deploy-unproven";

/**
 * o EFEITO DE ENTRADA de um passo (promote-stage / deploy-board /
 * promote-and-deploy) falhou ou foi recusado DEPOIS de a ação responder. O relatório do efeito
 * (runner/entry-effect-report.ts) o grava e o resolve na próxima vez que o efeito roda limpo; o Inbox o projeta
 * como o item `effect-failed` enquanto o card está no passo daquele efeito. Uma por card (upsert por id).
 */
export const ENTRY_EFFECT_FAILED_FINDING_ID = "entry-effect-failed";

/**
 * Parada por recurso — o card ficou num passo em que o PRÓXIMO ATOR É O
 * SISTEMA (um passo com efeito de entrada, ou um card conduzido) sem ninguém trabalhando nele e sem nada que explique
 * a espera. Quem o grava é o vigia (runner/stall-watch.ts), DEPOIS de já ter refeito o passo uma vez quando isso é
 * seguro; quem o fecha é o próprio vigia (o card voltou a ter dono) ou a saída do passo. O Inbox o projeta como o
 * item `stalled`. Um por card (upsert por id); `title` e `detail` já vêm em linguagem de dono.
 */
export const CARD_STALLED_FINDING_ID = "card-stalled";

/**
 * WS-3 — o passo que CARREGA o deploy (o "Publicando" onde o card agora ESPERA o settle),
 * identificado pelo efeito onEnter — nunca por id hardcoded (board-agnóstico). Mora AQUI, no módulo puro
 * client-safe, porque três pontas precisam da MESMA régua: a derivação de demanda (o watchdog abaixo), o
 * settle handler (deploy-reconcile, que só avança um card parado NESTE passo) e o revert (deploy-revert,
 * que reverte a partir dele). Duas cópias divergiriam no dia em que uma mudasse — o drift clássico.
 */
export function isDeployStep(def: Pick<StatusDef, "onEnter"> | null | undefined): boolean {
  return def?.onEnter === "promote-and-deploy" || def?.onEnter === "deploy-board";
}

export type DemandType =
  /** open agent questions awaiting the human (the cascade is paused on them) */
  | "question"
  /** F8 — a PRODUCTION PUBLISH failed and the card was reverted to `release` (deploy-revert.ts). Antes disto
   *  a falha só existia como finding `high` — e `high` não gerava demanda NENHUMA: o card revertido descia na
   *  lane VERDE "Liberar", igualzinho a um card saudável, e o copiloto olhava o cockpit e via "nada a fazer".
   *  A falha não era só invisível: era ativamente classificada como SAÚDE. */
  | "deploy-failed"
  /** open `blocker` review finding (gate hasNoBlockers keeps the card stuck) */
  | "blocker"
  /** low-confidence triage flagged for a human look (card.needsHumanReview) */
  | "review"
  /** the card rests in a non-terminal, non-autorun step — only the operator moves it forward */
  | "gate"
  /** the merge train PAUSED on a content conflict (blocks ALL integration behind it) */
  | "merge-conflict"
  /** the merge train PAUSED on a red integration gate (vitest) */
  | "merge-gate-failed"
  /** WS1.5: code staged/approved has idled in release/stage past its SLA (phantom-done — nobody
   *  notices approved code sitting unpublished); severity escalates with age */
  | "release-aging"
  /** WS1.1: a deploy FIRED (deployFiredAt) but never settled (the webhook stayed silent) past its SLA —
   *  the "No ar" mentiroso watchdog: if the restart itself died the settle never arrives and the card
   *  would lie "No ar" forever. B21: only while the card waits in the deploy step (outside it the stamp is
   *  history — closed by the write chokepoint / the service sweep). */
  | "deploy-unsettled"
  /** B2 — o efeito de entrada do passo falhou/foi recusado depois do clique (ver {@link ENTRY_EFFECT_FAILED_FINDING_ID}). */
  | "effect-failed"
  /** paradas por recurso, fatia 1 — o card está num passo em que o próximo ator é o SISTEMA, sem ninguém cuidando e
   *  sem nada que explique a espera (ver {@link CARD_STALLED_FINDING_ID}). */
  | "stalled";

export type DemandSeverity = "critical" | "high" | "medium" | "low";

/**
 * WS1.5 — thresholds + injected clock for the TIME-based demands (release-aging today; deploy-unsettled
 * lands with WS1.1). Kept as an explicit param so the rule stays a PURE, deterministically-unit-testable
 * derivation: tests inject `now`; production callers omit `opts` and inherit Date.now() + the plan SLAs.
 * A caller holding RunnerSettings MAY override the thresholds — the demand still flows through the SINGLE
 * `cardDemands` derivation that the per-card badge, the Central and the web-push channel all share.
 */
export interface DemandTimingOpts {
  /** epoch-ms "now" — injected by tests; defaults to Date.now() at the callsite. */
  now?: number;
  /** hours a card may sit STAGED-but-not-RELEASED before release-aging fires (default 24; ≥72 → high). */
  releaseAgingHours?: number;
  /** minutes a FIRED deploy may go un-settled (webhook silent) before deploy-unsettled fires (default 15). */
  deployUnsettledMinutes?: number;
  /** F9/B14 — quando cada card ENTROU no status em que está (o ISO da última transição para ele — o ledger de
   *  transições, lido pelo coletor). É o `since` dos itens que nascem de campos do card (revisão, bloqueio, aviso,
   *  gate, deploy falho, efeito falho, exclusão de dados). Sem registro ⇒ a criação do card. */
  stepEnteredAt?: ReadonlyMap<string, string>;
  /**
   * Os cards em que um agente TRABALHA agora (run, reserva, sessão — o coletor mede). Uma entrega parada em «Aprovar
   * entrega» só vira pedido de aprovação ao dono quando ninguém do sistema vai seguir com ela: com um condutor ou um
   * trabalho vivo no card, não é pedido falso.
   */
  workedCardIds?: ReadonlySet<string>;
}

/** SLA (hours) before staged-but-unpublished code raises release-aging. */
export const RELEASE_AGING_HOURS_DEFAULT = 24;
/** At/after this age (hours) release-aging escalates medium → high. */
export const RELEASE_AGING_HIGH_HOURS = 72;
/** SLA (minutes) before a fired-but-unsettled deploy raises deploy-unsettled (the "No ar" mentiroso watchdog). */
export const DEPLOY_UNSETTLED_MINUTES_DEFAULT = 15;

export interface Demand {
  type: DemandType;
  boardId: string;
  cardId: string;
  cardTitle: string;
  status: string | null;
  /** one-line, human-facing: WHAT the operator must do */
  label: string;
  severity: DemandSeverity;
  /** question/blocker: how many */
  count?: number;
  /** best-effort timestamp the demand has waited since (for oldest-first / FIFO ordering) */
  since?: string | null;
  /** merge demands: the run/session id (== branch run/<id>) the action targets */
  runId?: string;
  /** B9 — o deploy declarado PEDIU o dono (saída 3, fase `needs-human`): nada falhou. /perguntas agrupa essa demanda
   *  sob «Precisa de você», não sob «Deploy falhou» (o que a v0.9.6 consertou só no Inbox). Esparso. */
  needsHuman?: true;
  /** o deploy pediu uma PROVA (saída 3, fase `needs-proof`): trabalho do SISTEMA (a revisão de
   *  segurança independente e a republicação), nunca uma decisão do operador. Esparso. */
  needsProof?: true;
  /** B11 — o id do ITEM do Inbox que esta demanda projeta (o mesmo que cardCockpitItems constrói): os links da
   *  demanda (/perguntas, a pílula do Kanban, o push) abrem o ITEM, nunca o `?focus=<cardId>` que acendia o primeiro
   *  item do card. Ausente ⇒ a lista do Inbox. */
  itemId?: string;
}

export const SEVERITY_RANK: Record<DemandSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/**
 * Cockpit urgency buckets — the three lanes a CockpitItem still carries (`lane`): travado, pergunta, aprovar. A tela do
 * Inbox não as desenha mais (onda 2: as seções são Decidir / Acompanhar / Resolvido, por quem age a seguir), mas elas
 * seguem ordenando o coletor (compareCockpitItems) e o tick do Jido.
 */
export type CockpitGroup = "travado" | "pergunta" | "aprovar";

/** F8 — o finding ABERTO de um deploy que falhou (severity `high`, não `blocker`: ele não pode GATEAR nada —
 *  o caminho release→deploy não tem gate, e o humano/copiloto precisa poder re-publicar na hora). */
function openDeployFailure(card: Card) {
  return (card.findings ?? []).find((f) => f.id === DEPLOY_FAILURE_FINDING_ID && f.status === "open") ?? null;
}

/**
 * SUPERSEDE os findings de fase de ENTREGA quando o card VOLTA para implementação — o par do
 * `resolveStaleQuestions` (questions.ts) para findings. Um `deploy-failure` aberto descreve a falha de um
 * CICLO DE ENTREGA que morreu; se o card foi devolvido a um step de implementação (redrive/regressão), o
 * novo ciclo re-gera a própria verdade de entrega (release/settle/deployProof) — e o finding velho só
 * MENTE na UI: projetava "Republicar"/"Release falhou" sobre um card com run de implementação ATIVO
 * (o caso real: um card devolvido à implementação). Pure + idempotente: nada a supersedir ⇒
 * o MESMO array (referência preservada — o chamador pode usar identidade para pular o write).
 */
export function supersedeDeliveryFindingsOnReentry(
  findings: Card["findings"] | undefined,
  at: string,
): Card["findings"] | undefined {
  if (!findings?.some((f) => f.id === DEPLOY_FAILURE_FINDING_ID && f.status === "open")) return findings;
  return findings.map((f) =>
    f.id === DEPLOY_FAILURE_FINDING_ID && f.status === "open"
      ? {
          ...f,
          status: "fixed" as const,
          statusBy: "system:reentrada-implementacao",
          statusAt: at,
          detail: `${f.detail ?? ""}\n\n[SUPERSEDIDO em ${at}: o card voltou para implementação — este finding descrevia o ciclo de entrega ANTERIOR; o novo ciclo re-gera a verdade de entrega (release/settle/deployProof).]`.trim(),
        }
      : f,
  );
}

/**
 * um publish está EM VOO para este card: ele espera no passo de publicação com
 * o disparo carimbado. É a régua ÚNICA de «desabilite Publicar/Re-publicar — aguarde o settle»: o carimbo sozinho
 * mentia fora do passo (um card devolvido a Liberar levava o carimbo junto, e o Inbox mostrava, no mesmo card,
 * «Re-publicar» desabilitado ao lado de «Aprovar & avançar → Publicar» habilitado). PURE.
 */
export function deliveryInFlight(card: Pick<Card, "status" | "deployFiredAt">, config: Pick<BoardConfig, "statuses">): boolean {
  return !!card.deployFiredAt && isDeployStep(config.statuses.find((s) => s.id === card.status));
}

/** Os achados que são DO PASSO onde nasceram — a saída do passo os fecha — e quem assina o fechamento de cada um. */
const STEP_BOUND_FINDING_CLOSER: ReadonlyMap<string, string> = new Map([
  [ENTRY_EFFECT_FAILED_FINDING_ID, "system:saiu-da-etapa"],
  [CARD_STALLED_FINDING_ID, "system:saiu-do-passo"],
]);

/**
 * B21 — a TENTATIVA DE ENTREGA (o carimbo do disparo, os alvos e o `deploy-unproven` aberto) é do fluxo de
 * entrega: nasce no disparo, fecha no settle ou no revert — e é ENCERRADA quando o card sai do passo de publicação
 * por qualquer outro caminho (move à mão, MCP, gaveta, aceite, reabertura, refino, descontinuação). Antes nada
 * no caminho de mudança de status a limpava, e o carimbo seguia o card para sempre.
 *
 * A regra da CHOKEPOINT de escrita (write.ts `updateCardOnDisk` a aplica a TODA escrita que muda o status): o card
 * `next` que `prev` virou, com a tentativa encerrada — ou null quando não há nada a encerrar. Detalhes:
 *  - `deployTargets` FICAM quando o card sai com um `deploy-failure` aberto: a reconciliação por evidência precisa
 *    deles para fechar a falha de uma publicação feita fora do board;
 *  - o avanço do PRÓPRIO settle (a escrita que carimbou a prova) não é tocado — ele já fecha a tentativa;
 *  - a falha do efeito de entrada (B2) é da etapa que o card deixou: qualquer mudança de status a fecha;
 *  - a parada sem ninguém cuidando (o vigia — {@link CARD_STALLED_FINDING_ID}) também: o card ANDOU, então alguém o
 *    moveu — o que o achado dizia («parado em «X»») deixou de ser verdade no instante da mudança.
 * PURE.
 */
export function exitStepAttempt(prev: Card, next: Card, config: Pick<BoardConfig, "statuses">, at: string): Card | null {
  if ((prev.status ?? null) === (next.status ?? null)) return null;
  let out = next;
  let changed = false;
  const stepBound = (f: Card["findings"][number]) => f.status === "open" && STEP_BOUND_FINDING_CLOSER.has(f.id);
  if ((out.findings ?? []).some(stepBound)) {
    out = {
      ...out,
      findings: out.findings.map((f) =>
        stepBound(f) ? { ...f, status: "fixed" as const, statusBy: STEP_BOUND_FINDING_CLOSER.get(f.id), statusAt: at } : f,
      ),
    };
    changed = true;
  }
  const byId = (id: string | null | undefined) => config.statuses.find((s) => s.id === id);
  const leavesDeploy = isDeployStep(byId(prev.status)) && !isDeployStep(byId(next.status));
  const settleOwnAdvance = !!next.deployProof && next.deployProof !== prev.deployProof;
  if (leavesDeploy && !settleOwnAdvance) {
    const superseded = supersedeDeliveryAttempt(out, at, "system:saiu-de-publicar");
    if (superseded) {
      out = superseded;
      changed = true;
    }
  }
  return changed ? out : null;
}

/** O encerramento da tentativa em si (sem olhar status): carimbo e alvos fora, `deploy-unproven` fechado. null =
 *  nada a encerrar. PURE. */
function supersedeDeliveryAttempt(card: Card, at: string, by: string): Card | null {
  const keepTargets = (card.findings ?? []).some((f) => f.id === DEPLOY_FAILURE_FINDING_ID && f.status === "open");
  const hasStamp = card.deployFiredAt != null;
  const hasTargets = !keepTargets && (card.deployTargets?.length ?? 0) > 0;
  const hasUnproven = (card.findings ?? []).some((f) => f.id === DEPLOY_UNPROVEN_FINDING_ID && f.status === "open");
  if (!hasStamp && !hasTargets && !hasUnproven) return null;
  const out: Card = {
    ...card,
    deployFiredAt: undefined,
    ...(keepTargets ? {} : { deployTargets: undefined }),
    findings: (card.findings ?? []).map((f) =>
      f.id === DEPLOY_UNPROVEN_FINDING_ID && f.status === "open"
        ? {
            ...f,
            status: "fixed" as const,
            statusBy: by,
            statusAt: at,
            detail: `${f.detail ?? ""}\n\n[ENCERRADO em ${at}: o card saiu do passo de publicação — esta tentativa de entrega acabou; a próxima entrada em Publicar começa outra.]`.trim(),
          }
        : f,
    ),
  };
  return out;
}

/** Id da NOTA informativa que a varredura deixa num card terminal que carregava o carimbo sem prova (B21). */
export const DEPLOY_STAMP_HISTORY_FINDING_ID = "deploy-stamp-historico";

/**
 * B21 — a varredura do SERVIÇO (deploy-reconcile, a cada ciclo) sobre um carimbo de disparo que ficou para trás
 * FORA do passo de publicação — o legado de antes da chokepoint (cards da era otimista, cards movidos à mão):
 *  - terminal COM prova ⇒ o carimbo sai (a prova já diz tudo o que ele dizia);
 *  - terminal SEM prova ⇒ uma NOTA informativa (severity low, já `acknowledged`: fica registrada no card e fora
 *    do Inbox — é história, não decisão) e o carimbo sai;
 *  - não terminal ⇒ a tentativa é encerrada como na chokepoint.
 * No passo de publicação o carimbo é VIVO (o watchdog é dele) ⇒ null; sem carimbo ⇒ null. PURE.
 */
export function staleDeliveryStampSweep(card: Card, config: Pick<BoardConfig, "statuses">, at: string): Card | null {
  if (!card.deployFiredAt) return null;
  const def = config.statuses.find((s) => s.id === card.status);
  if (isDeployStep(def)) return null;
  if (def?.terminal) {
    if (card.deployProof) return { ...card, deployFiredAt: undefined };
    const note: Card["findings"][number] = {
      id: DEPLOY_STAMP_HISTORY_FINDING_ID,
      lens: "general",
      severity: "low",
      title: "Publicado sem a prova de deploy registrada",
      detail:
        `O card chegou a «${def.name}» com um disparo de deploy carimbado em ${card.deployFiredAt} e sem prova de que o ` +
        "código dele subiu (antes de a prova existir, ou movido à mão). Registro histórico — nada a decidir.",
      status: "acknowledged",
      statusBy: "system:varredura",
      statusAt: at,
    };
    const has = (card.findings ?? []).some((f) => f.id === DEPLOY_STAMP_HISTORY_FINDING_ID);
    return { ...card, deployFiredAt: undefined, findings: has ? card.findings : [...(card.findings ?? []), note] };
  }
  return supersedeDeliveryAttempt(card, at, "system:varredura");
}

/** Open blocker findings still awaiting human resolution (these fail gate hasNoBlockers). */
function openBlockers(card: Card) {
  return (card.findings ?? []).filter((f) => f.status === "open" && f.severity === "blocker");
}

/**
 * Os AVISOS abertos: findings `open` que NÃO travam gate — tudo que não é `blocker`. O par exato de
 * {@link openBlockers}, e a fonte do kind `finding`.
 *
 * O `deploy-failure` é EXCLUÍDO explicitamente e não por severity: ele é `high` (não pode gatear o caminho
 * release→deploy — ver {@link openDeployFailure}), então a régua de severity o classificaria como aviso e ele
 * seria projetado DUAS vezes — como `deploy-failed` 🔴 ("o trabalho está fora do ar, re-publique") e como
 * `finding` 🟡 ("dê um desfecho a este aviso"). Dois itens para um fato é sempre ruim; aqui seria pior, porque o
 * desfecho barato do segundo (`acknowledged`) APAGA o primeiro: o alarme de produção sumiria por triagem, que é
 * exatamente o que o DeployFailedRenderer se recusa a oferecer ao humano.
 */
function openAdvisories(card: Card) {
  return (card.findings ?? []).filter(
    (f) =>
      f.status === "open" &&
      f.severity !== "blocker" &&
      f.id !== DEPLOY_FAILURE_FINDING_ID &&
      // o settle sem prova tem item PRÓPRIO (deploy-unsettled/held): como aviso genérico ele ofereceria
      // «marcar como visto» sobre um card que continua fora do ar sem prova.
      f.id !== DEPLOY_UNPROVEN_FINDING_ID &&
      // B2 — o efeito de entrada que falhou também tem item próprio (`effect-failed`, com «tentar de novo»); fora
      // do passo do efeito ele é história, não aviso a triar.
      f.id !== ENTRY_EFFECT_FAILED_FINDING_ID &&
      // o card parado sem ninguém cuidando tem item PRÓPRIO (`stalled`): como aviso genérico ele ofereceria «marcar
      // como visto» sobre um card que continua travado.
      f.id !== CARD_STALLED_FINDING_ID,
  );
}

/** B2 — a falha do efeito de entrada que o Inbox projeta: aberta E o card no passo que DECLARA um efeito. Fora
 *  dele o finding é história (o card saiu — a chokepoint de escrita o fecha). PURE. */
function effectFailureInStep(card: Card, def: StatusDef | undefined) {
  return def?.onEnter ? openEntryEffectFailure(card) : null;
}

/** B2 — o efeito de entrada que falhou, ABERTO (ver {@link ENTRY_EFFECT_FAILED_FINDING_ID}). */
function openEntryEffectFailure(card: Card) {
  return (card.findings ?? []).find((f) => f.id === ENTRY_EFFECT_FAILED_FINDING_ID && f.status === "open") ?? null;
}

/** O card parado sem ninguém cuidando, ABERTO (ver {@link CARD_STALLED_FINDING_ID}). Vale em QUALQUER passo não
 *  terminal — o vigia o grava num passo com efeito de entrada ou num card conduzido, e a saída do passo o fecha. */
function openCardStall(card: Card) {
  return (card.findings ?? []).find((f) => f.id === CARD_STALLED_FINDING_ID && f.status === "open") ?? null;
}

/** O settle chegou e não provou: o finding aberto que guarda o motivo (ver {@link DEPLOY_UNPROVEN_FINDING_ID}). */
function openDeployUnproven(card: Card) {
  return (card.findings ?? []).find((f) => f.id === DEPLOY_UNPROVEN_FINDING_ID && f.status === "open") ?? null;
}

/**
 * O card está em Publicar ESPERANDO a prova do deploy (disparado, ou o settle chegou sem provar) — não a
 * aprovação de alguém. Aqui o item genérico «aprovar» mentia: não há aprovação a dar, o próximo passo (o
 * terminal) é gatado pela PROVA. Quem fala desse card é o `deploy-unsettled` (held na hora; sem settle, após o SLA).
 */
function awaitingDeployProof(card: Card, def: StatusDef | undefined): boolean {
  return isDeployStep(def) && (!!card.deployFiredAt || !!openDeployUnproven(card));
}

/**
 * True when an AGENT has already produced substantive WORK on the card — a design (wireframe), code
 * (a review run / findings / a commit range), QA, or a staged/released integration — as opposed to
 * mere planning (enrich/prioritize, which only fill narrative/RICE). This is the cockpit's entry
 * axis: a manual step the card reached AFTER work was produced is an APPROVAL the automation waits on
 * (aprovar design/entrega, publicar); a manual step reached with NOTHING run yet (triage intake, "a
 * fazer" after estimate) is BACKLOG the operator drives on the board — not a pilotage demand. Pure
 * (card fields only, no IO) so it stays node-unit-testable alongside the rest of this module.
 */
export function hasProducedWork(
  card: Pick<
    Card,
    "wireframeChosen" | "reviewedAt" | "qaRanAt" | "qaPassed" | "stagedAt" | "releasedAt" | "commitRange" | "findings"
  >,
): boolean {
  return Boolean(
    card.wireframeChosen ||
      card.reviewedAt ||
      card.qaRanAt ||
      card.qaPassed ||
      card.stagedAt ||
      card.releasedAt ||
      card.commitRange ||
      (card.findings && card.findings.length > 0),
  );
}

/**
 * A revisão de TRIAGEM ainda é devida? `needsHumanReview` significa uma coisa só: **este card chegou
 * sem ninguém olhar** (texto livre da triagem, ou um lote aplicado por agente). Logo ela só é devida
 * enquanto o card AINDA ESTÁ na quarentena — a lane `staging`. Assim que ele avança, alguém decidiu:
 * a revisão ACONTECEU, e uma flag esquecida no card não pode ressuscitar a cobrança.
 *
 * Existe como predicado ÚNICO porque havia DOIS consumidores lendo o mesmo campo com regras
 * diferentes: o item do cockpit já tinha a guarda `def.staging`, o CTA do card não tinha guarda
 * nenhuma — e por isso "Revisar item da triagem (baixa confiança)" continuava aparecendo num card
 * que já estava em Dúvidas, com um run em voo. Duas leituras da mesma flag são duas verdades; esta é
 * a única. (Um card em `staging` nunca tem run em voo — a lane não é de trabalho —, então não há
 * condição extra a checar sobre execução.)
 */
export function needsTriageReview(
  card: Pick<Card, "needsHumanReview" | "businessClasses" | "triageDecision" | "autonomyMode">,
  def: { staging?: boolean } | null | undefined,
  config?: Pick<BoardConfig, "autonomy"> | null,
): boolean {
  if (!(card.needsHumanReview && def?.staging)) return false;
  if (!config || !isBusinessOnly(card, config)) return true;
  // SÓ-NEGÓCIO: a revisão da triagem é do JUIZ (triage/judge.ts). Ao dono ela chega só quando o card toca
  // uma classe dele, ou quando o juiz não conseguiu decidir (`hold`) — com o motivo no rótulo.
  return Boolean(card.businessClasses?.ids.length) || card.triageDecision?.verdict === "hold";
}

/** O rótulo da revisão da triagem — nomeia a classe do dono ou o motivo do juiz, quando há. PURE. */
export function triageReviewLabel(card: Pick<Card, "businessClasses" | "triageDecision">, config: Pick<BoardConfig, "autonomy">): string {
  const cls = cardOwnerClass(card);
  if (cls) return `Decidir na triagem — toca «${ownerClassLabel(cls, config)}»`;
  if (card.triageDecision?.verdict === "hold") return `Decidir na triagem — o juiz não conseguiu: ${card.triageDecision.reason}`;
  return "Revisar item da triagem (baixa confiança)";
}

/** A descontinuação `excluir-tudo` esperando a aprovação IRREVERSÍVEL da exclusão de dados. Uma régua só para as
 *  duas projeções (demanda e item) e para o rodapé do Kanban — B1: todas oferecem a APROVAÇÃO, nunca um move. PURE. */
export function pendingDataDeletion(card: Pick<Card, "mode" | "retirement">): boolean {
  return card.mode === "retire" && card.retirement?.level === "excluir-tudo" && card.retirement.dataDeletionApproved === false;
}

/**
 * The pending HUMAN demands ON a single card — pure. A card resting in a non-terminal, non-autorun
 * step is a human GATE (the cascade will not advance it; only the operator can) — the SAME
 * `autorun !== true && !terminal` heuristic the web-push channel already uses for needsYou, so the
 * card surface and the push agree. Open questions, open blockers and low-confidence triage are
 * demand FACETS that co-exist with the gate; the UI groups them by card. Terminal cards never demand
 * (their questions are auto-resolved as stale on entry to a terminal column).
 */
/**
 * Whole+fractional hours between an ISO instant (`YYYY-MM-DD` day-granular for stagedAt, or a full ISO
 * timestamp) and `now` (epoch ms). null when absent/unparseable. NOTE: stagedAt is day-granular in
 * production (repo.coerceCard → toDateString), so release-aging resolves to ±1 day — fine for a 24h/72h
 * advisory alarm; tests inject precise instants.
 */
function ageHours(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return (now - t) / 3_600_000;
}

export function cardDemands(card: Card, config: BoardConfig, boardId: string, opts?: DemandTimingOpts): Demand[] {
  const out: Demand[] = [];
  const base = { boardId, cardId: card.id, cardTitle: card.title, status: card.status };
  const def = config.statuses.find((s) => s.id === card.status);

  // WS1.1 + deploy-truth (D-DT7) — deploy-unsettled: a card STUCK in the deploy step ("Publicando"): since
  // deploy-truth the terminal is only entered on a PROVEN settle, so a settle that never arrives (dead restart,
  // killed declared deploy command) — or one that arrived without proof — leaves the card parked there with deployFiredAt
  // uncleared. SÓ nesse passo. O predicado era independente de status para pegar o card da era
  // otimista que chegou ao terminal com o carimbo — e assim o carimbo seguia QUALQUER card movido para fora de
  // Publicar, para sempre. O legado é da varredura do serviço (staleDeliveryStampSweep); a saída do passo, da
  // chokepoint de escrita (exitStepAttempt).
  // O settle CHEGOU e não provou: a demanda é imediata (não há o que esperar) e o label é o motivo que o settle
  // deixou no card — nunca «settle não chegou», que seria falso. Só enquanto o card espera em Publicar: fora dele
  // (devolvido, movido à mão) o motivo é história, e «Re-publicar» no lugar não teria de onde partir.
  const unproven = isDeployStep(def) ? openDeployUnproven(card) : null;
  if (unproven) {
    out.push({ ...base, type: "deploy-unsettled", severity: "high", label: unproven.title, since: card.deployFiredAt ?? null, itemId: `${card.id}:deploy-unsettled` });
  } else if (card.deployFiredAt && isDeployStep(def)) {
    // B21 — SÓ no passo de publicação: fora dele o carimbo é história (a chokepoint de escrita e a varredura o
    // encerram), e um watchdog ali mentia «deploy sem confirmação» ao lado de «Aprovar & avançar → Publicar».
    const age = ageHours(card.deployFiredAt, opts?.now ?? Date.now());
    const thresholdMin = opts?.deployUnsettledMinutes ?? DEPLOY_UNSETTLED_MINUTES_DEFAULT;
    if (age !== null && age * 60 >= thresholdMin) {
      out.push({
        ...base,
        type: "deploy-unsettled",
        severity: "high",
        label: "Card preso em Publicando — deploy disparado sem confirmação (settle não chegou)",
        since: card.deployFiredAt,
        itemId: `${card.id}:deploy-unsettled`,
      });
    }
  }

  // F8 — deploy FALHOU: como o deploy-unsettled acima, é checado ANTES do guard de terminal. Um revert que não
  // conseguiu landar (board sem coluna `release`) deixa o card TERMINAL carregando o finding aberto — que é
  // justamente o caso em que a mentira "está no ar" custa mais caro. A demanda tem de sobreviver ao early-return.
  const deployFail = openDeployFailure(card);
  if (deployFail) {
    // needs-proof: o sistema está produzindo a prova — trabalho dele, com severidade baixa (nada a fazer do dono).
    const proof = deployFail.deployPhase === "needs-proof";
    out.push({
      ...base,
      type: "deploy-failed",
      severity: proof ? "low" : "critical",
      label: deployFail.title ?? "Deploy de produção falhou — o código não está no ar",
      itemId: `${card.id}:deploy-failed`,
      ...(deployFail.deployPhase === "needs-human" ? { needsHuman: true as const } : {}),
      ...(proof ? { needsProof: true as const } : {}),
    });
  }

  if (!def || def.terminal) return out;

  // A question an ULTRA story's PROXY is taking (autonomy.ts) does not wait on the owner — it leaves the demand the
  // moment it is proxiable, and comes back the moment the proxy hands it back (declined/failed, written on the card).
  // A human story (every board without the autonomy block) has no proxiable question: the count is the legacy one.
  const open = openQuestions(card).filter((q) => !isProxiableQuestion(q, card, config));
  if (open.length) {
    const since = open.map((q) => q.askedAt).filter((d): d is string => Boolean(d)).sort()[0] ?? null;
    out.push({
      ...base,
      type: "question",
      severity: "high",
      count: open.length,
      label: `Responder ${open.length} pergunta${open.length === 1 ? "" : "s"}`,
      since,
      itemId: `${card.id}:q:${open[0].id}`,
    });
  }

  const blockers = openBlockers(card);
  if (blockers.length) {
    out.push({
      ...base,
      type: "blocker",
      severity: "high",
      count: blockers.length,
      label: `Resolver ${blockers.length} bloqueio${blockers.length === 1 ? "" : "s"} de revisão`,
      itemId: `${card.id}:b:${blockers[0].id}`,
    });
  }

  if (needsTriageReview(card, def, config)) {
    out.push({ ...base, type: "review", severity: "medium", label: triageReviewLabel(card, config), itemId: `${card.id}:review` });
  }

  // B2 — o efeito de entrada do passo não rodou: o card não espera aprovação, espera o conserto do efeito.
  const effectFailed = effectFailureInStep(card, def);
  if (effectFailed) {
    out.push({ ...base, type: "effect-failed", severity: "high", label: effectFailed.title, itemId: `${card.id}:effect-failed` });
  }

  // O card parado sem ninguém cuidando (o vigia): como o efeito que não rodou, ele não espera aprovação — espera o
  // conserto. O rótulo é o título do achado, que o vigia já escreve em linguagem de dono.
  const stalled = openCardStall(card);
  if (stalled) {
    out.push({ ...base, type: "stalled", severity: "high", label: stalled.title, itemId: `${card.id}:stalled` });
  }

  // Human GATE: the card is parked in a non-terminal manual step the cascade won't auto-advance. We
  // surface it ONLY when an agent has ALREADY PRODUCED WORK on the card (hasProducedWork) — i.e. it's
  // an APPROVAL the automation is waiting on (aprovar design/entrega, publicar). A manual step the
  // card reached with NOTHING run yet (triage intake, "a fazer" after estimate) is BACKLOG the
  // operator drives on the board, NOT a pilotage demand — surfacing it here is exactly the noise that
  // turned "precisa de você" into a mirror of the backlog (the cockpit is exceptions-of-the-running-
  // automation, not a to-do). `label` is the step's own name (board-agnostic, no hardcoded map),
  // e.g. "Aprovar entrega", "Aprovar design", "Publicar".
  // B9 — a MESMA exclusão do cardCockpitItems: no passo de aprovar design (gate hasWireframe) quem fala é o item
  // `design` (o canvas, dobrado do sidecar), não o gate genérico. Sem ela o Kanban dizia «Aprovar design» e o
  // «Ver o que falta» não acendia nada no Inbox.
  // o card que ESPERA a prova de segurança no passo de publicar não é um «Publicar» do dono: o
  // sistema republica sozinho quando a prova sai.
  const waitingProof = deployFail?.deployPhase === "needs-proof";
  if (def.autorun !== true && def.gate !== "hasWireframe" && hasProducedWork(card) && !awaitingDeployProof(card, def) && !effectFailed && !stalled && !waitingProof) {
    out.push({ ...base, type: "gate", severity: "medium", label: def.name ?? "Decisão pendente", itemId: `${card.id}:approval:${card.status}` });
  }

  // story-ex0118: the `descontinuar` executor is now autorun:true + its lane hidden, so the generic gate
  // demand above is SKIPPED and a retire card paused on the IRREVERSIBLE data-deletion approval
  // (excluir-tudo) would be invisible on every surface. Surface that ONE approval ALWAYS — it is the
  // single step the operator MUST confirm before production data is wiped. (Questions/blockers already
  // surface via their own non-autorun-gated branches above; only this card-field gate was orphaned.)
  if (pendingDataDeletion(card)) {
    out.push({ ...base, type: "gate", severity: "high", label: "Aprovar exclusão de dados (irreversível)", itemId: `${card.id}:data-deletion` });
  }

  // WS1.5 — release-aging: code that reached a publish-resting step (`stage`/`release` — the canonical _base
  // pre-publish parkings; pipeline vocabulary, NOT brand names, so WS9-agnostic) and idled there past its SLA
  // is phantom-done: approved code sitting unpublished that nobody noticed. `stagedAt && !releasedAt` bounds
  // the window (staged, not yet live); the status scope keeps a reverted/reworked card carrying a stale
  // stagedAt in a DEV column from nagging. Age escalates severity medium → high. Advisory (a demand, NEVER a
  // gate): it surfaces the silence, never blocks the forward.
  if ((card.status === "stage" || card.status === "release") && card.stagedAt && !card.releasedAt) {
    const thresholdH = opts?.releaseAgingHours ?? RELEASE_AGING_HOURS_DEFAULT;
    const age = ageHours(card.stagedAt, opts?.now ?? Date.now());
    if (age !== null && age >= thresholdH) {
      out.push({
        ...base,
        type: "release-aging",
        severity: age >= RELEASE_AGING_HIGH_HOURS ? "high" : "medium",
        label: `Publicar código aprovado (parado há ${Math.floor(age / 24)}d)`,
        since: card.stagedAt,
        itemId: `${card.id}:release-aging`,
      });
    }
  }

  return out;
}

/** The single most-severe demand on a card (drives the card's one-line "precisa de você" badge +
 * its contextual primary action). null = nothing pending. */
export function dominantDemand(demands: Demand[]): Demand | null {
  if (!demands.length) return null;
  return [...demands].sort((a, z) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[z.severity])[0];
}

// ── Cockpit items — the TYPED inbox model (per-board Inbox) ──────────────────────────────────
// A CockpitItem is a TYPED projection of a sub-record that lives ON the parent CARD (a question, a
// blocker finding, a triage review flag, a post-work gate). Every item ALWAYS carries its parent
// cardId — there are NO orphan items (the card itself is gated to have a story parent). Each `kind`
// owns its own payload, and (in the UI) its own renderer + actions — so the panel is a real inbox +
// pilot-deck: the system/agents CREATE entries (a question WITH suggested options, a blocker, an
// approval) and the human decides per-item with the RIGHT controls (a question never shows "advance").
// Extensible: a new kind = one entry in this union + one projection branch + one UI renderer.

export type CockpitItemKind =
  | "question"
  | "blocker"
  /** Um AVISO: finding de review ABERTO e non-blocker (high/medium/low). Não trava gate nenhum — e era
   *  exatamente por isso que ninguém o projetava: o cockpit só emitia o `blocker`, então um aviso aberto
   *  não era item de nada e o tick NUNCA o via (um card com avisos abertos e nenhum item no cockpit, com o board
   *  dizendo "nada acionável"). Não travar não é o mesmo que não ser trabalho: um aviso aberto para sempre é
   *  dívida INVISÍVEL — e a única saída que ele tem é alguém decidir o desfecho dele. Ver {@link openAdvisories}. */
  | "finding"
  /** F8 — o deploy de produção FALHOU e o card foi revertido: pronto, aprovado, e fora do ar. */
  | "deploy-failed"
  /** F8 — o card parou num passo MANUAL com trabalho já produzido, esperando alguém empurrar ("Aprovar entrega",
   *  "Publicar"). Era `approval` — o MESMO kind dos pedidos de aprovação que o PRÓPRIO copiloto abre. Conflati-los
   *  significava que tornar a fila acionável faria o tick acordar por causa do próprio pedido (laço). São coisas
   *  diferentes: este é trabalho do board esperando decisão; `approval` é o copiloto esperando VOCÊ. */
  | "gate"
  | "approval"
  | "review"
  | "stuck"
  | "conflict"
  | "proposal"
  | "design"
  | "governance"
  /** WS-5 (D9) — deploy disparado (deployFiredAt) sem settle além do SLA: o watchdog "No ar mentiroso". */
  | "deploy-unsettled"
  /** WS-5 (D9) — código staged sem release além do SLA: o phantom-done aprovado-e-parado. */
  | "release-aging"
  /** WS-5 (D9) — entry TERMINAL `failed` do merge train (a mais recente do card): trabalho fora da main. */
  | "merge-failed"
  /** lanes-ultra — uma resposta que o PROXY (modo ultra) deu no lugar do dono e caiu na AMOSTRA de auditoria. */
  | "proxy-audit"
  /** v0.9 — uma ENTREGA AUTÔNOMA (modo ultra: ninguém aprovou antes) chegou ao ar e caiu na AMOSTRA de auditoria. */
  | "delivery-audit"
  /** v0.9 — o MEDIDOR de cota do governador PAROU: a automação inteira está retida. Fato do HOST, não de um card —
   *  aparece uma vez no Inbox de todo board enquanto durar ({@link meterStallItem}). */
  | "meter-stalled"
  /** B1 — a aprovação IRREVERSÍVEL da exclusão de dados de uma descontinuação (`excluir-tudo`). Era `approval`, que o
   *  Inbox desenhava com o GateRenderer: a primária MOVIA o card (→ Arquivados), a exclusão nunca rodava e o item sumia
   *  pelo guard de terminal — resolvia em falso. Kind próprio, ligado a approveDataDeletionAction. */
  | "data-deletion"
  /** B2 — o efeito de entrada do passo onde o card está (publicar, promover) falhou ou foi recusado depois do
   *  clique. Era só uma linha de log: o dono lia «ok» e o card ficava parado sem nada vermelho. */
  | "effect-failed"
  /** paradas por recurso, fatia 1 — o card ficou num passo em que o próximo ator é o SISTEMA, sem ninguém trabalhando
   *  nele e sem nada que explique a espera; o vigia já refez o passo uma vez (quando era seguro) e abriu o card de
   *  conserto. Antes disto o card só ficava lá, com «Publicando» pulsando sobre nada. */
  | "stalled"
  /** Execução aprovada — um agente propôs um comando que a TRAVA DURA do host recusa a agentes; o dono aprova (o
   *  serviço roda uma vez, confere, desfaz se falhar), recusa, ou — depois — desfaz/mantém. Também os desfechos que
   *  só informam (falhou, desfeito, expirou), até o dono dar «Ok». runner/locked-exec*. */
  | "locked-exec";

interface CockpitItemBase {
  /** stable id, unique within the board (e.g. `<cardId>:q:<questionId>`) */
  id: string;
  kind: CockpitItemKind;
  boardId: string;
  /** the PARENT card — ALWAYS present (no orphan items; mirrors the story orphan gate) */
  cardId: string;
  cardTitle: string;
  /** the parent card's current status id (context) */
  status: string | null;
  lane: CockpitGroup;
  severity: DemandSeverity;
  /** best-effort timestamp the item has waited since (oldest-first ordering) */
  since?: string | null;
  /** WS-12.2 (D16) — the autonomous copiloto GAVE UP on this item: it tried `streak` times without moving it,
   *  so the tick stopped re-driving it and the item is the human's. Folded in at board level from the durable
   *  orchestrator state (cockpit-collect) — absent means "not in backoff", which is the normal case. The chip
   *  it renders is the visible half of "desistir é um evento": the item was already sitting here, but nothing
   *  said the division of labour had changed. Re-armable in one click (copilot-actions/rearmCopilotItemAction). */
  copilotBackoff?: { streak: number };
}

/** 🟡 An agent question awaiting the human — with optional agent-suggested options + a free answer. */
export interface QuestionCockpitItem extends CockpitItemBase {
  kind: "question";
  questionId: string;
  prompt: string;
  /** agent-suggested options ([] = pure free-text). Each may carry pros/cons + a `recommended` flag. */
  options: QuestionOption[];
  /** single (radio) | multi (checkbox). A free answer is ALWAYS available too. */
  mode: QuestionMode;
  askedBy?: string;
  /** the agent's "why" — the stakes/context that help the human decide. */
  context?: string;
  /** the agent's prose recommendation for a PURE free-text question (no discrete options). */
  recommendation?: string;
  /** the asker's CATEGORY (autonomy.ts) — the renderer names it. */
  category?: QuestionCategory;
  /** a decision only the OWNER makes (money / [humano]) — never proxied, never the copiloto's. */
  ownerOnly?: true;
  /** the story is ULTRA and this question is the PROXY's right now — the owner may still answer first. */
  awaitingProxy?: true;
}

/**
 * 🟢 A proxy answer on the owner's AUDIT list (ultra mode): the answer the proxy gave FOR the owner, with the
 * premissas it recorded and its confidence. The owner confirms it, or reopens the question (it comes back to them
 * — never to the proxy). It is the owner's review of a decision made on their behalf: never the copiloto's.
 */
export interface ProxyAuditCockpitItem extends CockpitItemBase {
  kind: "proxy-audit";
  questionId: string;
  prompt: string;
  /** the proxy's answer — the free text plus the labels of the options it picked. */
  answer: string;
  assumptions: string;
  confidence: number;
  category?: QuestionCategory;
}

/**
 * 🟢 v0.9 — an AUTONOMOUS DELIVERY on the owner's audit list (ultra mode — delivery-audit.ts): the story reached a
 * `delivered` status with no one approving it first, and the deterministic sample picked it. The owner CONFIRMS it
 * (it stands) or REOPENS it (the story goes back through refine, with the owner's reason as a finding). It is the
 * owner's review of work shipped on their behalf: never the copiloto's.
 */
export interface DeliveryAuditCockpitItem extends CockpitItemBase {
  kind: "delivery-audit";
  /** when the delivery was sampled (YYYY-MM-DD). */
  sampledAt: string;
  /** the `## Prova da entrega` the conductor wrote (trimmed), when the card has one. */
  proof?: string;
  /** what the user saw BEFORE and sees NOW (the proof's `Antes:`/`Depois:` lines), when it says. */
  before?: string;
  after?: string;
  /** where to see it live: the proof's `Link:`, else the board's public URL (`faceUrl`). */
  link?: string;
}

/**
 * 🔴 v0.9 — o MEDIDOR de cota parou (runner/capacity-governor: a leitura de uso envelheceu depois de já ter sido
 * vista). Com ele parado o governador RETÉM toda automação, e nada no board diz por quê — o token que renovaria a
 * leitura só renova com tráfego, então o impasse não se desfaz sozinho. É um fato do HOST: sem card (`cardId` ""),
 * o mesmo item em todo board, enquanto durar. O conserto é do operador (tráfego pelo proxy / renovar o token).
 */
export interface MeterStalledCockpitItem extends CockpitItemBase {
  kind: "meter-stalled";
  /** epoch ms da última leitura BOA — o "parado desde". */
  stalledSince: number;
  /** epoch ms em que o governador detectou a parada. */
  detectedAt: number;
  /** o que o governador mediu (texto dele, curto). */
  detail: string;
}

/** O fato do governador que {@link meterStallItem} projeta (capacity-governor `snapshot().meterStall`). */
export interface MeterStall {
  since: number;
  detectedAt: number;
  detail: string;
}

/**
 * O item do Inbox de um medidor de cota parado, para `boardId` — ou null quando o medidor está vivo. PURA. O id é
 * estável por EPISÓDIO (a mesma parada é o mesmo item; uma nova parada é um item novo, que o "visto" não esconde).
 */
export function meterStallItem(stall: MeterStall | null | undefined, boardId: string): MeterStalledCockpitItem | null {
  if (!stall || !Number.isFinite(stall.since)) return null;
  return {
    id: `host:meter-stalled:${stall.since}`,
    kind: "meter-stalled",
    boardId,
    cardId: "",
    cardTitle: "Medidor de cota",
    status: null,
    lane: "travado",
    severity: "high",
    since: new Date(stall.since).toISOString(),
    stalledSince: stall.since,
    detectedAt: stall.detectedAt,
    detail: stall.detail,
  };
}

/** 🔴 An open blocker finding (code review) keeping the card stuck. */
export interface BlockerCockpitItem extends CockpitItemBase {
  kind: "blocker";
  findingId: string;
  title: string;
  lens?: string;
  suggestion?: string;
}

/**
 * 🟡 Um AVISO de review aberto (non-blocker) esperando um DESFECHO. Mesma forma do {@link BlockerCockpitItem}
 * (nasce do mesmo `findings[]`), mas kind próprio porque o ATO é outro: um blocker TRAVA o gate e precisa sair
 * para o card andar; um aviso não trava nada — ele espera alguém dizer o que fazer com ele
 * (`fixed`/`wontfix`/`acknowledged`). Conflati-los daria ao aviso a urgência 🔴 de um bloqueio e à lane travado
 * um item que não trava ninguém.
 *
 * `severity` do item = a do finding (high/medium/low), NUNCA inventada: um aviso `low` que se apresentasse como
 * `high` gastaria a atenção do operador (e o budget do tick) na ordem errada — a lane já ordena por ela.
 */
export interface FindingCockpitItem extends CockpitItemBase {
  kind: "finding";
  findingId: string;
  title: string;
  lens?: string;
  suggestion?: string;
  /** a severity DO FINDING — `blocker` nunca aparece aqui (é o kind {@link BlockerCockpitItem}). */
  findingSeverity: Exclude<FindingSeverity, "blocker">;
}

/** 🔴 F8 — o publish de produção FALHOU e o card foi revertido: pronto, aprovado, e fora do ar. Mesma forma do
 *  blocker (nasce de um finding), mas kind próprio — é o que o copiloto autônomo consome para RE-PUBLICAR, e o
 *  que a UI precisa parar de pintar de verde. */
export interface DeployFailedCockpitItem extends CockpitItemBase {
  kind: "deploy-failed";
  findingId: string;
  title: string;
  lens?: string;
  suggestion?: string;
  /** O deploy declarado PEDIU o dono (fase `needs-human` do finding — saída 3: há unidade que só ele publica).
   *  Nada falhou: o rótulo diz «Precisa de você» e o Jido não o pega (republicar antes do dono publicar a
   *  unidade só repete o pedido). Esparso: ausente em toda falha de verdade. */
  needsHuman?: true;
  /** o deploy pediu uma PROVA (fase `needs-proof`): o sistema a produz e republica. Trabalho do
   *  sistema (Acompanhar), nunca do dono; o Jido não o pega (republicar antes da prova só repete o pedido). */
  needsProof?: true;
}

/** 🟢 F8 — um gate manual DO BOARD: a automação produziu trabalho e espera alguém empurrar ("Aprovar entrega",
 *  "Publicar"). É a fila que um orquestrador de ponta a ponta trabalha. Separado de {@link ApprovalCockpitItem}
 *  — que é o pedido de aprovação DO PRÓPRIO COPILOTO — porque conflati-los faria o tick acordar por causa de si. */
export interface GateCockpitItem extends CockpitItemBase {
  kind: "gate";
  /** the gate's label = the manual step name ("Aprovar entrega", "Publicar"). */
  gateLabel: string;
  /**
   * O passo é a APROVAÇÃO DA ENTREGA (a parada manual gatada por `hasQaPassed` — delivery-audit.ts). Num board
   * só-negócio o condutor atravessa esse passo sozinho, com a prova; um card PARADO nele, com trabalho pronto, é uma
   * entrega que ninguém do sistema vai mover (o condutor parou ali de propósito, ou acabou) — quem decide é o dono
   * (decision-class.ts, ponto `gate`). Ausente/false = um gate qualquer.
   */
  deliveryApproval?: boolean;
}

/** 🟢 O copiloto PEDIU sua aprovação para uma ação `ask` da matriz de risco (approvals.ts). Espera VOCÊ. */
export interface ApprovalCockpitItem extends CockpitItemBase {
  kind: "approval";
  /** the gate's label — aqui, "Copiloto pede: <tool> (<classe>)". */
  gateLabel: string;
  /** WS-3 §3.5 (D12) — mirror of the ApprovalRequest sidecar (approvals.ts) for an informed decision:
   *  fim da aprovação às cegas. */
  tool?: string;
  /** canonical JSON (string, ≤2KB — truncated on creation, approvals.ts:112). Render verbatim. */
  args?: string;
  riskClass?: RiskClass;
  requestedAt?: string;
  expiresAt?: string;
  note?: string;
  /** B4 — quem pediu de verdade (o ator MCP; "run:orch" nos registros antigos) e por quê. */
  requestedBy?: string;
  reason?: "risk-matrix";
}

/**
 * 🟢 B1 — a exclusão IRREVERSÍVEL dos dados de produção de uma descontinuação (`retirement.level: excluir-tudo`)
 * esperando o dono. O item carrega O QUE será apagado — o motivo, as superfícies e o alvo que o dono declarou ao
 * descontinuar — para que a confirmação diga isso antes do clique. A decisão é SÓ do dono (KIND_AUTONOMY `never`).
 */
export interface DataDeletionCockpitItem extends CockpitItemBase {
  kind: "data-deletion";
  /** o motivo da descontinuação (retirement.brief). */
  brief: string;
  /** as superfícies declaradas (ids de RemovalScope — a tela os nomeia). */
  scope: string[];
  /** a rota/feature sob remoção; null = a story inteira. */
  target: string | null;
}

/**
 * 🔴 B2 — o efeito de entrada do passo onde o card está NÃO RODOU: falhou ou foi recusado depois de a ação responder
 * (o descritor de deploy inválido, o comando não autorizado, a autorização do preflight recusada, a promoção adiada).
 * Nasce do finding {@link ENTRY_EFFECT_FAILED_FINDING_ID}; a saída é tentar de novo NO LUGAR (republishCardAction),
 * depois de resolver o motivo. Resolve quando o efeito roda limpo, ou quando o card sai do passo.
 */
export interface EffectFailedCockpitItem extends CockpitItemBase {
  kind: "effect-failed";
  findingId: string;
  title: string;
  /** o motivo, em português (o que a recusa/o erro disse). */
  detail?: string;
  suggestion?: string;
  /** o efeito do passo onde o card está — o que «tentar de novo» roda. */
  effect: EntryEffect;
  /** o nome do passo (ex.: «Publicar»). */
  stepName: string;
}

/**
 * 🔴 Paradas por recurso, fatia 1 — o card está PARADO num passo em que quem age a seguir é o sistema, sem ninguém
 * cuidando. Nasce do achado {@link CARD_STALLED_FINDING_ID}, que o vigia (runner/stall-watch.ts) grava DEPOIS de já
 * ter refeito o passo uma vez (quando isso é seguro) e de abrir o card de conserto — por isso o título e o detalhe já
 * vêm em linguagem de dono e o item os repete sem reescrever. Resolve quando o vigia vê o card com dono de novo, ou
 * quando o card sai do passo ({@link exitStepAttempt}).
 */
export interface StalledCockpitItem extends CockpitItemBase {
  kind: "stalled";
  findingId: string;
  /** o título do achado — o que aconteceu, já em linguagem de dono («Parado em «Publicar» sem ninguém cuidando»). */
  findingTitle: string;
  /** o detalhe do achado — desde quando, o que o sistema tentou e o card de conserto; null quando o vigia não o gravou. */
  findingDetail: string | null;
  suggestion?: string;
  /** o nome do passo onde o card parou (ex.: «Publicar»). */
  stepName: string;
  /** o passo declara uma ação automática de entrada (`onEnter`) ⇒ há o que refazer NO LUGAR (republishCardAction). */
  retryable: boolean;
  /** o efeito do passo, quando ele declara um — o que «tentar de novo» roda. Presente sse `retryable`. */
  effect?: EntryEffect;
}

/** 🟡 A low-confidence triage intake the agent flagged for a human decision (accept/decline/dedupe). */
export interface ReviewCockpitItem extends CockpitItemBase {
  kind: "review";
}

/** 🔴 A run that failed (error/timeout/oom). Source: telemetry/journal — folded in at board level. */
export interface StuckCockpitItem extends CockpitItemBase {
  kind: "stuck";
  trigger?: string;
  outcome?: string;
  /** o MOTIVO da morte (a `RunnerFailureReason`: error/timeout/oom-killed/exit/no-op/budget-cut) — a régua de máquina;
   *  `outcome` é o texto de detalhe quando há. */
  reason?: string;
  /**
   * B6 — o diagnóstico que o SISTEMA carimbou no card sobre esta mesma morte (`run-death`, `budget-cut`), dobrado
   * aqui como EVIDÊNCIA ({@link foldRunDiagnostics}) em vez de virar um segundo item («Triar achado · run morreu»).
   */
  evidence?: { findingId: string; title: string; detail?: string; failureClass?: FailureClass };
}

/** 🔴 A merge-train conflict / gate-failure. Source: merge queue — folded in at board level. */
export interface ConflictCockpitItem extends CockpitItemBase {
  kind: "conflict";
  runId?: string;
  conflictKind: "merge-conflict" | "merge-gate-failed";
  /**
   * WS-10.5 (D14) — the semantic ladder's per-hunk verdicts, when it CLIMBED and escalated. This is the whole
   * point of the WS: a parked item stops being a raw `git merge` stderr and becomes "hunk X é substantivo
   * PORQUE …" that the operator decides ON. Carried verbatim from `MergeQueueEntry.resolutionAnalysis`.
   *
   * ABSENT ⇒ the ladder never ran (flag off, a live session's conflict, board data, or a non-text failure) —
   * NOT "it ran and found nothing". The renderer must therefore fall back to today's presentation, never to an
   * empty box that reads like "the judge cleared it".
   */
  resolutionAnalysis?: EntryResolutionAnalysis;
}

/** 🟢 A smart-capture proposal awaiting the human: accept (create the cards) or refine (re-run). Source:
 * proposals/<containerId>.json — folded in at board level. The capture container card is the parent. */
export interface ProposalCockpitItem extends CockpitItemBase {
  kind: "proposal";
  /** the agent's interpretation summary (empty while still generating in `capturando`). */
  summary: string;
  /** the proposed cards to create (empty while still generating). */
  items: ProposedItem[];
  /** how many refine rounds happened so far (feedback length). */
  rounds: number;
}

/** 🟢 A design approval awaiting the human: review the canvas (per-artifact feedback + primary) and
 * advance. Source: wireframes/<id>.json — folded in at board level. The story card is the parent.
 * Replaces the generic `approval` at the "approve design" stop. */
export interface DesignCockpitItem extends CockpitItemBase {
  kind: "design";
  /** the usage journey (harness-ux) the screens realize — shown above the canvas so the human approves both together */
  journey: WireframeJourney | null;
  /** LEGACY options (pre-canvas docs) — the renderer derives the canvas view from these when artifacts is empty */
  options: WireframeOption[];
  /** the design canvas (Canvas v2) — authored artifacts + the human feedback thread */
  artifacts: DesignArtifact[];
  feedback: DesignFeedbackEntry[];
  chosenId: string | null;
}

/**
 * 🟢 A governance proposal awaiting the operator's decision — approve (promote to canonical) or reject
 * (discard, canonical intact). Source: governance/<draftId>.json — folded in at board level.
 * `cardId = originCardId ?? ""` (no orphan gap; CockpitItemRow hides "Abrir card" when empty).
 * 1 draft = 1 decision (AC6): multiple related changes are grouped in ONE item.
 */
export interface GovernanceCockpitItem extends CockpitItemBase {
  kind: "governance";
  draftId: string;
  changes: GovernanceChange[];
  reason: string;
  origin?: { skill?: string | null; cardId?: string | null } | null;
  /** Labels of changes whose `before` snapshot diverges from the current canonical (conflict warning). */
  conflicts: string[];
  /** B8 — a recusa que «Aprovar» receberia do servidor agora (config OU documento — governance-check.ts), dita
   *  ANTES do clique. Ausente ⇒ aprovar passaria. */
  conflictMessage?: string;
  /** B8 — as propostas pendentes que esta substituiu ao nascer (mesmas seções). */
  supersedes?: string[];
}

/** 🔴 WS-5 — um deploy FIRED (deployFiredAt) cujo settle-webhook silenciou além do SLA. Read-only +
 *  escalação (D6): NUNCA oferecer "settle manual" 1-clique — a semântica do settle é do webhook. */
export interface DeployUnsettledCockpitItem extends CockpitItemBase {
  kind: "deploy-unsettled";
  /** ISO do disparo (o campo do card; limpo pelo settle — deploy-revert.ts). */
  deployFiredAt: string;
  /** O settle CHEGOU e não provou — o que ele deixou no card ({@link DEPLOY_UNPROVEN_FINDING_ID}): o título, o
   *  motivo em português (com o código) e o conserto. Ausente ⇒ o settle ainda não chegou (o watchdog do SLA). */
  held?: { title: string; detail?: string; suggestion?: string };
  /**
   * B3 — o ÚLTIMO deploy dos alvos deste card, segundo o registry do serviço (dobrado no coletor por
   * {@link foldLastDeploy}). `running` ⇒ ainda roda (D6: nada de re-disparo às cegas); `done`/`failed` ⇒ terminou
   * e não confirmou; `null` ⇒ o registry não conhece job desses alvos (o serviço reiniciou desde o disparo) — nada
   * roda. AUSENTE ⇒ não se sabe (card sem alvos: self-deploy, que o registry não acompanha).
   */
  lastDeploy?: { target: string; status: "running" | "done" | "failed"; finishedAt?: string; exitCode?: number } | null;
}

/** 🔴 WS-5 — código staged (stagedAt && !releasedAt, status stage/release) parado além do SLA. */
export interface ReleaseAgingCockpitItem extends CockpitItemBase {
  kind: "release-aging";
  stagedAt: string;
  /** idade inteira em dias (rótulo "parado há Nd" — derivada com o `now` injetado). */
  ageDays: number;
}

/** 🔴 WS-5 — a entry MAIS RECENTE do card no train terminou `failed` (branch sumida, split reprovado,
 *  abort do operador). Fonte: merge-queue snapshot — dobrada no board level. */
export interface MergeFailedCockpitItem extends CockpitItemBase {
  kind: "merge-failed";
  runId: string;
  /** a branch como registrada na entry (pode já ser a preservada `failed/run/<id>`). */
  branch: string;
  /** failureReason da entry, truncado a 300 chars na projeção. */
  failureReason?: string;
}

/** Uma conferência de um comando travado, como o Inbox a mostra. */
export interface LockedExecCheckView {
  label: string;
  command: string;
  /** o programa que de fato roda (caminho real, resolvido pelo serviço). */
  program: string;
  /** o critério, em português («passa se terminar com código 0 e a saída contiver “…”»). */
  criterion: string;
}

/** Um passo já rodado, resumido para o Inbox. */
export interface LockedExecStepView {
  step: string;
  ok: boolean;
  exitCode: number | null;
  /** a cauda curta da saída (stdout, senão stderr), para o dono ver o que o comando disse. */
  output: string;
  error?: string;
}

/**
 * 🔴/🟢 Execução aprovada (runner/locked-exec*): um pedido de rodar UM comando travado, com tudo o que o dono precisa
 * ver antes de decidir — o resumo do agente, o COMANDO EXATO (a linha que a trava julgou), o desfazer ou o plano B, e
 * as conferências — e, depois, o desfecho passo a passo. `hash` é o que a aprovação devolve ao servidor: o pedido que o
 * dono viu, byte a byte.
 */
export interface LockedExecCockpitItem extends CockpitItemBase {
  kind: "locked-exec";
  lockedExecId: string;
  hash: string;
  execStatus: "pending" | "approved" | "running" | "done" | "failed" | "undone" | "rejected" | "expired" | "stale" | "kept";
  /** as palavras do AGENTE — a tela as mostra DEPOIS do bloco estruturado, rotuladas «Explicação do agente». */
  summary: string;
  why: string | null;
  command: string;
  /** o programa que de fato roda (caminho real). */
  program: string;
  undoCommand: string | null;
  undoProgram: string | null;
  noUndoPlan: string | null;
  preflight: LockedExecCheckView[];
  verify: LockedExecCheckView[];
  timeoutSec: number;
  proposedBy: string;
  proposedAt: string;
  /** o que a trava disse do comando (a regra), para os Detalhes. */
  lockRule: string | null;
  expiresAt: string | null;
  finishedAt: string | null;
  undoing: boolean;
  autoUndone: boolean;
  error: string | null;
  rejectReason: string | null;
  steps: LockedExecStepView[];
}

export type CockpitItem =
  | QuestionCockpitItem
  | BlockerCockpitItem
  | FindingCockpitItem
  | DeployFailedCockpitItem
  | GateCockpitItem
  | ApprovalCockpitItem
  | ReviewCockpitItem
  | StuckCockpitItem
  | ConflictCockpitItem
  | ProposalCockpitItem
  | DesignCockpitItem
  | GovernanceCockpitItem
  | DeployUnsettledCockpitItem
  | ReleaseAgingCockpitItem
  | MergeFailedCockpitItem
  | ProxyAuditCockpitItem
  | DeliveryAuditCockpitItem
  | MeterStalledCockpitItem
  | DataDeletionCockpitItem
  | EffectFailedCockpitItem
  | StalledCockpitItem
  | LockedExecCockpitItem;

/**
 * 6.4 — quem pode ACIONAR cada kind do cockpit, POR TIER do copiloto. O princípio (herdado da F8) é um só:
 * **um kind é acionável para um tier quando aquele tier tem a FERRAMENTA e o MANDATO de resolvê-lo**. Acordar
 * por causa de um item que você não pode mexer é acordar para constatar impotência — e queimar budget (era o
 * laço de spawn diário: uma pergunta humana pendente acordava um copiloto que não podia fazer nada sobre ela).
 *
 * EXAUSTIVA POR TIPO (`Record<CockpitItemKind, …>`): um kind NOVO é ERRO DE COMPILAÇÃO até alguém decidir o
 * tier dele. É a governança da D13 ("expandir o conjunto é decisão separada") cobrada pelo compilador, e não
 * pela memória — antes, um kind novo caía silenciosamente em "não-acionável" e ninguém era obrigado a olhar.
 *
 *  - `"base"`     → TODO tier ativo age (Copiloto **e** Autônomo): demanda de SISTEMA com tool na matriz de
 *                   ambos e sem julgamento de produto no caminho (os 5 sinais da F8 + `merge-failed`).
 *  - `"autonomo"` → SÓ o Autônomo. Precisam do JULGAMENTO (decidir produto/UX) ou do PODER (`deploy: auto`)
 *                   que só a stance/matriz do Autônomo concede — ver {@link CopilotTier}. Para o Copiloto
 *                   seriam exatamente a impotência acima: ele acordaria para escalar de volta ao humano.
 *  - `"never"`    → nenhum tier, nunca. Invariante ANTI-LAÇO, não knob de tier (o análogo, aqui, do
 *                   `run-free`/`destructive` que seguem humanos em QUALQUER tier na matriz de risco).
 *
 * Classifique por KIND, nunca por lane: `blocker` divide a lane 🔴 com stuck/conflict e mesmo assim tem tier
 * próprio.
 */
type KindAutonomy = "base" | "autonomo" | "never";

const KIND_AUTONOMY: Record<CockpitItemKind, KindAutonomy> = {
  // ── base: o Copiloto tem tool para cada um, e nenhum exige decidir produto ───────────────────────────────
  stuck: "base", // um run morreu → cancel_run + enqueue (classe `run`)
  conflict: "base", // a merge train parqueou → resolve_merge (classe `merge-resolve`)
  question: "base", // F6.3 — responde as factualmente apuráveis; a DECISÃO de produto continua sua
  "deploy-failed": "base", // o deploy falhou e o card voltou → re-publicar (classe `deploy`). Era invisível: o
  // card revertido descia na lane VERDE "Liberar" e o cockpit não emitia NADA de acionável — o copiloto
  // acordava, olhava, e voltava a dormir com "skipped-no-work". A falha era classificada como saúde.
  gate: "base", // o card parou num passo manual COM trabalho pronto ("Aprovar entrega", "Publicar") — é a fila
  // que define entregar de ponta a ponta. NÃO confundir com `approval` (abaixo).
  "merge-failed": "base", // a entry mais recente do card no train falhou (branch sumida, split reprovado, abort)
  // → re-drive/escalar. PROMOVIDO ao Copiloto por decisão do Operador, fechando a governança que a
  // D13 tinha deixado aberta: a AÇÃO já é `merge-resolve`, que a matriz do Copiloto tem em `auto` desde sempre —
  // ele PODIA resolver a entry e mesmo assim não acordava por ela. Era o inverso exato do princípio desta tabela
  // (poder sem despertar, em vez de despertar sem poder): a falha do train ficava esperando o humano num tier
  // que já a resolvia sozinho. É o MESMO ato que `conflict` (base desde a F8) — só o desfecho da entry difere.

  // ── autonomo: paridade com o humano no Inbox. Cada um destes é uma DECISÃO (produto/UX) ou um ato de
  // DEPLOY — precisamente o que a AUTONOMO_STANCE autoriza ("decide produto/UX quando o caminho é claro e
  // PUBLICA sozinho") e a DEFER_STANCE proíbe. Isto NÃO é poder novo: a matriz de risco + o guard por chamada
  // seguem sendo a contenção real — aqui só se decide POR QUE ELE ACORDA. ────────────────────────────────────
  blocker: "autonomo", // finding de review escalado ao humano: um defeito objetivo que o orquestrador de ponta
  // a ponta consegue trabalhar. Para o Copiloto seria acordar para reescalar.
  finding: "autonomo", // AVISO aberto (non-blocker): dar desfecho a ele é JULGAR ("isto é dívida conhecida" ×
  // "isto o card conserta agora") — a decisão que a AUTONOMO_STANCE autoriza e a DEFER_STANCE proíbe. Para o
  // Copiloto seria a impotência canônica desta tabela: acordar para devolver ao humano. CONVERGE por construção
  // — o desfecho tira o finding de `open`, o item some do set, e nenhum tick acorda por ele de novo (é isso que
  // separa "acordar por um aviso low" de um laço: ele é tratado UMA vez, não re-dirigido para sempre).
  review: "autonomo", // triagem de baixa confiança parada na coluna → julgamento
  proposal: "autonomo", // aceitar/refinar uma proposta de captura → decisão de produto
  design: "autonomo", // escolher um wireframe → decisão de UX
  governance: "autonomo", // draft de campo de board (owner:human) esperando aprovação
  "deploy-unsettled": "autonomo", // deploy disparado sem settle ("No ar mentiroso") → classe `deploy`
  "release-aging": "autonomo", // código staged sem release: publicar → classe `deploy`

  // ── never: invariante anti-laço (vale em TODO tier, inclusive Autônomo) ──────────────────────────────────
  // lanes-ultra — a auditoria de uma resposta do PROXY é a revisão do DONO sobre uma decisão tomada em nome dele;
  // um copiloto que a fechasse apagaria justamente o controle que a amostra existe para dar. (A tool que a fecha é
  // full-only também — as duas travas dizem a mesma coisa.)
  "proxy-audit": "never",
  // v0.9 — a auditoria de uma ENTREGA autônoma é a mesma coisa um degrau acima: o dono revisando o que foi entregue
  // em nome dele. Um copiloto que a confirmasse apagaria o único olhar humano sobre essa entrega.
  "delivery-audit": "never",
  // v0.9 — o medidor de cota parado: o conserto é tráfego pelo proxy ou renovar o token do medidor, mãos do
  // operador no host. Nenhum tier tem a alavanca — acordar o tick por isto seria acordar para constatar impotência.
  "meter-stalled": "never",
  // B1 — apagar dados de produção é o ato irreversível por excelência: a aprovação é do dono, em todo tier.
  "data-deletion": "never",
  // B2 — o efeito que não rodou pede CONSERTAR o motivo (config de deploy, autorização, trabalho concorrente) antes
  // de tentar de novo; re-disparar às cegas só repete a recusa. Nenhum tier acorda por ele até o dono decidir
  // expandir (D13) — a decisão fica registrada aqui, não inventada.
  "effect-failed": "never",
  // O card parado sem ninguém cuidando: quando o item nasce o vigia JÁ refez o passo uma vez e JÁ abriu o card de
  // conserto — o trabalho que resolve é aquele card, que anda pela fila como qualquer outro. Acordar o tick por este
  // item seria refazer às cegas o que acabou de não dar certo. Mesma classe do `effect-failed`.
  stalled: "never",
  // Execução aprovada — o comando travado só roda com o clique do DONO na sessão dele (a server action recusa qualquer
  // outro chamador). Nenhum tier tem a alavanca, e acordar por um pedido que ele mesmo não pode aprovar é o laço de
  // impotência desta tabela.
  "locked-exec": "never",
  approval: "never", // é o pedido que o PRÓPRIO copiloto abriu — ele aguarda VOCÊ. Se fosse acionável, o tick
  // acordaria por causa de si mesmo, veria "trabalho", e re-acordaria: laço. O gate DO CARD (que ele PODE
  // empurrar) é o kind `gate` — outro item, outra semântica.
};

const kindsWhere = (pred: (a: KindAutonomy) => boolean): ReadonlySet<CockpitItemKind> =>
  new Set((Object.keys(KIND_AUTONOMY) as CockpitItemKind[]).filter((k) => pred(KIND_AUTONOMY[k])));

/** Os kinds que o **Copiloto** (e o Standby, que sequer tem tick) aciona — os 5 da F8 + `merge-failed`. Expandir
 *  este conjunto é governança separada (D13): cada entrada aqui precisa de decisão do Operador, porque acordar o
 *  tick por algo que ele escala de volta é queimar budget. Ver também {@link AUTONOMO_ACTIONABLE_KINDS}. */
export const COPILOT_ACTIONABLE_KINDS: ReadonlySet<CockpitItemKind> = kindsWhere((a) => a === "base");

/** Os kinds que o **Autônomo** aciona: TODOS menos os `never` — paridade com o que o humano faz no Inbox,
 *  menos o que seria laço. Ver {@link KIND_AUTONOMY}. */
export const AUTONOMO_ACTIONABLE_KINDS: ReadonlySet<CockpitItemKind> = kindsWhere((a) => a !== "never");

/** O conjunto acionável DO TIER — a porta única (não leia os conjuntos direto). Standby cai no conjunto do
 *  Copiloto: ele não tem tick, então o conjunto é inerte, e o conservador é o default honesto. PURE. */
export function copilotActionableKinds(tier: CopilotTier): ReadonlySet<CockpitItemKind> {
  return tier === "autonomo" ? AUTONOMO_ACTIONABLE_KINDS : COPILOT_ACTIONABLE_KINDS;
}

/**
 * WS-5.1 (D9) — the `stuck` outcomes that are NOT copilot-actionable even though `stuck` IS an actionable
 * KIND. A `no-op` means the run concluded "there was NO WORK" (not a crash): the "cancel_run + enqueue"
 * playbook the tick applies to a stuck item is EXACTLY the wrong action for it — re-driving a no-op just
 * buys another no-op (a self-feeding loop). It stays VISIBLE to the human on
 * Inbox (travado lane — it may be a real symptom, e.g. a phantom-done card) but the autonomous tick
 * leaves it for the human after the first run. Keyed on the machine `outcome` (the telemetry RunOutcome the
 * stuck projection carries), never on freeform text.
 */
const NON_ACTIONABLE_STUCK_OUTCOMES: ReadonlySet<string> = new Set(["no-op"]);

/**
 * SÓ-NEGÓCIO (a D13 decidida: sim) — num board em só-negócio o Jido faz a RECUPERAÇÃO TÉCNICA e
 * só ela, com LIMITE de tentativas por tipo: execução travada, conflito e merge falho do train, publicação que falhou
 * (duas), e o efeito de entrada que não rodou (UMA — re-disparar às cegas só repete a recusa). Esgotado o limite ele
 * abre um card de conserto e segue (runner/business-recovery.ts) — nunca pergunta ao dono. O que NÃO é dele aqui: o
 * gate genérico (é do pipeline, do verificador e do condutor), a pergunta (do proxy), a triagem (do juiz), a tela, a
 * governança e as amostras (do dono). Um kind fora desta tabela não é acionável em só-negócio.
 */
const BUSINESS_RECOVERY_RETRY_LIMIT: Partial<Record<CockpitItemKind, number>> = {
  stuck: 2,
  conflict: 2,
  "merge-failed": 2,
  "deploy-failed": 2,
  "effect-failed": 1,
  // `stalled` fica FORA de propósito: o vigia já refez o passo uma vez e já abriu o card de conserto antes de o item
  // existir — o Jido não tenta de novo por cima (limite 0 ⇒ não é recuperação dele).
};

/** A execução travada que re-tentar NÃO conserta: o no-op (não havia trabalho) e o corte de orçamento (o teto é do
 *  dono — re-drivar só gasta de novo até o mesmo teto). */
const NON_RETRYABLE_STUCK_REASONS: ReadonlySet<string> = new Set(["no-op", "budget-cut"]);

/** Quantas vezes o Jido tenta um item de recuperação num board só-negócio antes de abrir o card de conserto. PURE. */
export function recoveryRetryLimit(kind: CockpitItemKind): number {
  return BUSINESS_RECOVERY_RETRY_LIMIT[kind] ?? 0;
}

/** O item é recuperação técnica que o Jido pega num board só-negócio, neste tier? PURE. */
export function isBusinessRecoveryItem(item: CockpitItem, tier: CopilotTier): boolean {
  if (tier === "chat" || !recoveryRetryLimit(item.kind)) return false;
  if (item.kind === "stuck" && NON_RETRYABLE_STUCK_REASONS.has(item.reason ?? item.outcome ?? "")) return false;
  if (item.kind === "deploy-failed" && (item.needsHuman || item.needsProof)) return false;
  // re-rodar o efeito do passo (publicar, promover) é um ato de DEPLOY: só no tier que publica.
  if (item.kind === "effect-failed" && tier !== "autonomo") return false;
  return true;
}

/** True when the autonomous copiloto tick could act on this item AT `tier` (see {@link KIND_AUTONOMY}). O tier
 *  é OBRIGATÓRIO de propósito: um default aqui seria uma segunda verdade sobre "o que ele pode", divergindo da
 *  matriz que o guard lê — o mesmo motivo que fez o tier ser uma PROJEÇÃO da matriz, e não um campo novo. Num board
 *  SÓ-NEGÓCIO (`opts.businessOnly`) a tabela é outra: só a recuperação técnica ({@link isBusinessRecoveryItem}). PURE. */
export function isCopilotActionable(item: CockpitItem, tier: CopilotTier, opts?: { businessOnly?: boolean }): boolean {
  if (opts?.businessOnly) return isBusinessRecoveryItem(item, tier);
  if (!copilotActionableKinds(tier).has(item.kind)) return false;
  // WS-5.1 (D9): a stuck item derived from a `no-op` run leaves the actionable set — see
  // {@link NON_ACTIONABLE_STUCK_OUTCOMES}. Only `stuck` carries an `outcome`; other kinds are unaffected.
  // INVARIANTE DE TIER (como `approval`): vale TAMBÉM no Autônomo. "Re-drivar um no-op compra outro no-op" é um
  // FATO sobre o playbook, não falta de poder — mais autonomia não torna a re-tentativa certa, só mais cara.
  if (item.kind === "stuck" && item.outcome != null && NON_ACTIONABLE_STUCK_OUTCOMES.has(item.outcome)) {
    return false;
  }
  // lanes-ultra — duas perguntas que NÃO são do copiloto, em todo tier: a de DINHEIRO (do dono, sempre — a tool
  // answer_question também a recusa) e a que o PROXY de uma story ultra está respondendo (acordar o tick para ela
  // seria correr contra o proxy pela mesma resposta).
  if (item.kind === "question" && (item.ownerOnly || item.awaitingProxy)) return false;
  // O deploy que pediu o DONO (saída 3 do deploy declarado): só ele publica a unidade, e republicar antes disso
  // só repete o pedido. Invariante de tier, como a pergunta de dinheiro — mais autonomia não publica a unidade.
  if (item.kind === "deploy-failed" && item.needsHuman) return false;
  // A prova que o SISTEMA está produzindo (needs-proof): republicar antes dela só repete o pedido.
  if (item.kind === "deploy-failed" && item.needsProof) return false;
  return true;
}

/**
 * The cockpit items that live ON a card — pure (card fields only). One `question` per open question
 * (carrying the agent's suggested options + mode), one `blocker` per open blocker finding, a `review`
 * while a low-confidence triage sits in the staging column, and an `approval` for a post-work manual
 * gate. `stuck`/`conflict` are folded in at board level from telemetry/merge-queue (IO). Terminal
 * cards never produce items (their questions auto-resolve as stale on entry to a terminal column).
 */
export function cardCockpitItems(card: Card, config: BoardConfig, boardId: string, opts?: DemandTimingOpts): CockpitItem[] {
  const out: CockpitItem[] = [];
  const base = { boardId, cardId: card.id, cardTitle: card.title, status: card.status };
  // F9/B14 — o `since` dos itens que nascem de CAMPOS do card: quando o card entrou no passo em que está (o ledger de
  // transições), senão a criação dele. Antes eles não tinham `since`: nenhuma idade à vista (revisões de triagem
  // paradas havia semanas pareciam novas) e a ordem «mais velho primeiro» os empurrava para o fim da raia.
  const stepSince = opts?.stepEnteredAt?.get(card.id) ?? card.created ?? null;

  // F8 — deploy falhou: ANTES do guard de terminal (ver cardDemands). É o item mais urgente que um board pode
  // ter — o trabalho está pronto, aprovado, e NÃO está no ar — e é o que o copiloto autônomo consome p/ re-publicar.
  const deployFail = openDeployFailure(card);
  if (deployFail) {
    out.push({
      ...base,
      id: `${card.id}:deploy-failed`,
      kind: "deploy-failed",
      lane: "travado",
      since: stepSince,
      // B9 — a MESMA severidade da demanda gêmea (era `critical` lá e `high` aqui): o trabalho está pronto e fora do
      // ar — o item mais urgente da raia. A prova que o SISTEMA está produzindo é baixa (nada a
      // fazer do operador — é trabalho dele acontecendo).
      severity: deployFail.deployPhase === "needs-proof" ? "low" : "critical",
      findingId: deployFail.id,
      title: deployFail.title,
      lens: deployFail.lens,
      suggestion: deployFail.suggestion,
      ...(deployFail.deployPhase === "needs-human" ? { needsHuman: true as const } : {}),
      ...(deployFail.deployPhase === "needs-proof" ? { needsProof: true as const } : {}),
    });
  }

  // WS-5 (D9) + deploy-truth (D-DT7) — deploy-unsettled: a card STUCK in the deploy step ("Publicando") whose
  // settle never arrived/proved — the terminal is settle-gated now, so the card parks there with deployFiredAt
  // uncleared. B21: só nesse passo (ver o gêmeo no cardDemands). Same predicate/threshold as the cardDemands twin —
  // the two derivations must never disagree.
  // O settle que CHEGOU sem provar vira o item NA HORA, com o motivo (o gêmeo do cardDemands acima — e, como
  // lá, só enquanto o card espera em Publicar).
  const unproven = isDeployStep(config.statuses.find((s) => s.id === card.status)) ? openDeployUnproven(card) : null;
  if (unproven) {
    out.push({
      ...base,
      id: `${card.id}:deploy-unsettled`,
      kind: "deploy-unsettled",
      lane: "travado",
      severity: "high",
      since: card.deployFiredAt ?? null,
      deployFiredAt: card.deployFiredAt ?? "",
      held: {
        title: unproven.title,
        ...(unproven.detail ? { detail: unproven.detail } : {}),
        ...(unproven.suggestion ? { suggestion: unproven.suggestion } : {}),
      },
    });
  } else if (card.deployFiredAt && isDeployStep(config.statuses.find((s) => s.id === card.status))) {
    // B21 — o gêmeo do cardDemands: o watchdog só existe enquanto o card espera no passo de publicação.
    const age = ageHours(card.deployFiredAt, opts?.now ?? Date.now());
    const thresholdMin = opts?.deployUnsettledMinutes ?? DEPLOY_UNSETTLED_MINUTES_DEFAULT;
    if (age !== null && age * 60 >= thresholdMin) {
      out.push({
        ...base,
        id: `${card.id}:deploy-unsettled`,
        kind: "deploy-unsettled",
        lane: "travado",
        severity: "high",
        since: card.deployFiredAt,
        deployFiredAt: card.deployFiredAt,
      });
    }
  }

  const def = config.statuses.find((s) => s.id === card.status);

  // lanes-ultra — the PROXY AUDIT list: a proxy answer sampled for the owner's review. BEFORE the terminal guard:
  // a story can ship before the owner audits, and a decision made on their behalf stays reviewable after it did.
  if (def) {
    for (const q of card.questions ?? []) {
      if (!isPendingProxyAudit(q) || !q.proxy) continue;
      const picked = (q.selectedOptionIds ?? []).map((id) => q.options?.find((o) => o.id === id)?.label).filter(Boolean);
      out.push({
        ...base,
        id: `${card.id}:pa:${q.id}`,
        kind: "proxy-audit",
        lane: "aprovar",
        severity: q.proxy.confidence < 0.5 ? "medium" : "low",
        since: q.answeredAt ?? null,
        questionId: q.id,
        prompt: q.text,
        answer: [picked.join(" + "), q.answer].filter(Boolean).join(" — "),
        assumptions: q.proxy.assumptions,
        confidence: q.proxy.confidence,
        ...(q.category ? { category: q.category } : {}),
      });
    }
  }

  // v0.9 — the DELIVERY AUDIT list: an autonomous delivery sampled for the owner's review. Also BEFORE the terminal
  // guard — the delivered status IS terminal ("No ar"), and that is exactly where this item has to show.
  if (def && isPendingDeliveryAudit(card) && card.deliveryAudit) {
    const proof = deliveryProofOf(card.body);
    const ba = deliveryBeforeAfterOf(card.body, config.faceUrl);
    const link = ba?.link ?? config.faceUrl;
    out.push({
      ...base,
      id: `${card.id}:da`,
      kind: "delivery-audit",
      lane: "aprovar",
      severity: "low",
      since: card.deliveryAudit.sampledAt,
      sampledAt: card.deliveryAudit.sampledAt,
      ...(proof ? { proof } : {}),
      ...(ba?.before ? { before: ba.before } : {}),
      ...(ba?.after ? { after: ba.after } : {}),
      ...(link ? { link } : {}),
    });
  }

  if (!def || def.terminal) return out;

  for (const q of openQuestions(card)) {
    out.push({
      ...base,
      id: `${card.id}:q:${q.id}`,
      kind: "question",
      lane: "pergunta",
      severity: "high",
      since: q.askedAt ?? null,
      questionId: q.id,
      prompt: q.text,
      options: q.options ?? [],
      mode: q.mode ?? "single",
      askedBy: q.askedBy,
      context: q.context,
      recommendation: q.recommendation,
      // Sparse (a legacy question carries none of the three — the item is byte-identical to what it was).
      // a categoria EFETIVA (a do autor, senão a do classificador) e a decisão do DONO (o piso de dinheiro, o
      // `[humano]`, ou uma classe de negócio) — nunca do proxy, nunca do copiloto.
      ...(effectiveQuestionCategory(q) ? { category: effectiveQuestionCategory(q) } : {}),
      ...(isOwnerDecisionQuestion(q) ? { ownerOnly: true as const } : {}),
      ...(isProxiableQuestion(q, card, config) ? { awaitingProxy: true as const } : {}),
    });
  }

  for (const f of openBlockers(card)) {
    out.push({
      ...base,
      id: `${card.id}:b:${f.id}`,
      kind: "blocker",
      lane: "travado",
      severity: "high",
      since: stepSince,
      findingId: f.id,
      title: f.title,
      lens: f.lens,
      suggestion: f.suggestion,
    });
  }

  // Os AVISOS (non-blocker). Lane `pergunta`, não `travado`: eles não travam NADA — o que falta é uma decisão
  // sobre cada um. A severity é a do finding, então um `low` desce para o fim da lane em vez de disputar
  // atenção com uma pergunta de verdade.
  for (const f of openAdvisories(card)) {
    out.push({
      ...base,
      id: `${card.id}:f:${f.id}`,
      kind: "finding",
      lane: "pergunta",
      since: stepSince,
      severity: f.severity as Exclude<FindingSeverity, "blocker">,
      findingId: f.id,
      title: f.title,
      lens: f.lens,
      suggestion: f.suggestion,
      findingSeverity: f.severity as Exclude<FindingSeverity, "blocker">,
    });
  }

  if (needsTriageReview(card, def, config)) {
    out.push({ ...base, id: `${card.id}:review`, kind: "review", lane: "pergunta", severity: "medium", since: stepSince });
  }

  // B2 — o efeito de entrada do passo não rodou (o gêmeo do cardDemands acima).
  const effectFailed = effectFailureInStep(card, def);
  if (effectFailed && def.onEnter) {
    out.push({
      ...base,
      id: `${card.id}:effect-failed`,
      kind: "effect-failed",
      lane: "travado",
      severity: "high",
      since: stepSince,
      findingId: effectFailed.id,
      title: effectFailed.title,
      ...(effectFailed.detail ? { detail: effectFailed.detail } : {}),
      ...(effectFailed.suggestion ? { suggestion: effectFailed.suggestion } : {}),
      effect: def.onEnter,
      stepName: def.name,
    });
  }

  // O card parado sem ninguém cuidando (o gêmeo do cardDemands acima). Em QUALQUER passo não terminal: o vigia o grava
  // num passo com efeito de entrada ou num card conduzido — só o «tentar de novo» depende de o passo ter um efeito.
  const stalled = openCardStall(card);
  if (stalled) {
    out.push({
      ...base,
      id: `${card.id}:stalled`,
      kind: "stalled",
      lane: "travado",
      severity: "high",
      since: stepSince,
      findingId: stalled.id,
      findingTitle: stalled.title,
      findingDetail: stalled.detail ?? null,
      ...(stalled.suggestion ? { suggestion: stalled.suggestion } : {}),
      stepName: def.name,
      retryable: Boolean(def.onEnter),
      ...(def.onEnter ? { effect: def.onEnter } : {}),
    });
  }

  // approval: a post-work manual gate (hasProducedWork + non-autorun) — the automation waits your OK.
  // The "approve design" stop (gate hasWireframe) is covered by the richer `design` item (board-level
  // folding from the wireframe sidecar), so skip the generic approval there to avoid a duplicate.
  if (def.autorun !== true && def.gate !== "hasWireframe" && hasProducedWork(card) && !awaitingDeployProof(card, def) && !effectFailed && !stalled) {
    out.push({
      ...base,
      // WS-12.4 (D16) — o STATUS entra no id. Sem ele o item de gate é o mesmo `<card>:approval` em TODA parada
      // manual do pipeline: um card que cruza um gate e para no PRÓXIMO (progresso REAL) herdava o streak
      // anti-noop do gate anterior — o copiloto chegava ao gate novo já tendo "desistido" dele. Com o status no
      // id, cruzar um gate faz o item antigo sumir do set e o novo nascer zerado (o rebuild-from-set do
      // bumpNoopByItem já poda o antigo). Entries antigas com o id curto morrem no primeiro bump (inofensivo).
      id: `${card.id}:approval:${card.status}`,
      kind: "gate",
      lane: "aprovar",
      severity: "medium",
      since: stepSince,
      gateLabel: def.name ?? "Decisão pendente",
      // o pedido ao dono só quando NINGUÉM do sistema vai seguir: nem condutor (que move revisão → integrar ele mesmo no
      // só-negócio), nem run/reserva/sessão vivos no card.
      ...(isDeliveryApprovalStep(def) && card.routing?.driver !== "conductor" && !opts?.workedCardIds?.has(card.id) ? { deliveryApproval: true } : {}),
    });
  }

  // story-ex0118: the IRREVERSIBLE data-deletion approval of a retire (excluir-tudo) — surfaced ALWAYS,
  // independent of the autorun gate above, because the `descontinuar` executor is now autorun + hidden
  // and this card-field gate would otherwise be unreachable (the operator could never approve the wipe).
  // B1 — kind PRÓPRIO: a aprovação desta exclusão é approveDataDeletionAction, nunca um move do card.
  if (pendingDataDeletion(card) && card.retirement) {
    out.push({
      ...base,
      id: `${card.id}:data-deletion`,
      kind: "data-deletion",
      lane: "aprovar",
      severity: "high",
      since: opts?.stepEnteredAt?.get(card.id) ?? card.retirement.openedAt ?? stepSince,
      brief: card.retirement.brief,
      scope: [...(card.retirement.scope ?? [])],
      target: card.retirement.target ?? null,
    });
  }

  // WS-5 (D9) — release-aging: AFTER the terminal guard (stage/release are non-terminal). Same predicate as
  // cardDemands: staged-but-unreleased past its SLA. Advisory (never a gate); escalates medium → high at 72h.
  if ((card.status === "stage" || card.status === "release") && card.stagedAt && !card.releasedAt) {
    const thresholdH = opts?.releaseAgingHours ?? RELEASE_AGING_HOURS_DEFAULT;
    const age = ageHours(card.stagedAt, opts?.now ?? Date.now());
    if (age !== null && age >= thresholdH) {
      out.push({
        ...base,
        id: `${card.id}:release-aging`,
        kind: "release-aging",
        lane: "travado",
        severity: age >= RELEASE_AGING_HIGH_HOURS ? "high" : "medium",
        since: card.stagedAt,
        stagedAt: card.stagedAt,
        ageDays: Math.floor(age / 24),
      });
    }
  }

  return out;
}

/** O fato do registry sobre o job de um alvo (ProductDeployRegistry.get) — só o que o watchdog precisa. */
export interface DeployJobFact {
  status: "running" | "done" | "failed";
  finishedAt?: number;
  exitCode?: number;
}

/**
 * dobra no watchdog `deploy-unsettled` SEM `held` o estado do último deploy
 * dos alvos do card. É o que dá saída a um card parado em Publicar desde antes da v0.9.6 (o settle o segurou sem
 * gravar o motivo): com o job terminado — ou desconhecido, depois de um restart —, re-publicar é seguro e o Inbox o
 * oferece; com o job rodando, segue só escalar (D6). Card sem alvos (self-deploy) fica sem o campo. PURE.
 */
export function foldLastDeploy(
  items: CockpitItem[],
  cardsById: ReadonlyMap<string, Pick<Card, "deployTargets">>,
  jobOf: (target: string) => DeployJobFact | undefined,
): CockpitItem[] {
  return items.map((item) => {
    if (item.kind !== "deploy-unsettled" || item.held) return item;
    const targets = cardsById.get(item.cardId)?.deployTargets?.filter(Boolean) ?? [];
    if (targets.length === 0) return item;
    const jobs = targets.map((target) => ({ target, job: jobOf(target) })).filter((j): j is { target: string; job: DeployJobFact } => !!j.job);
    const running = jobs.find((j) => j.job.status === "running");
    if (running) return { ...item, lastDeploy: { target: running.target, status: "running" as const } };
    const latest = jobs.sort((a, z) => (z.job.finishedAt ?? 0) - (a.job.finishedAt ?? 0))[0];
    return {
      ...item,
      lastDeploy: latest
        ? {
            target: latest.target,
            status: latest.job.status,
            ...(latest.job.finishedAt ? { finishedAt: new Date(latest.job.finishedAt).toISOString() } : {}),
            ...(latest.job.exitCode !== undefined ? { exitCode: latest.job.exitCode } : {}),
          }
        : null,
    };
  });
}

/** Epoch ms → ISO, ou null. */
function isoOf(ms: number | null | undefined): string | null {
  return typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}

const LANE_RANK: Record<CockpitGroup, number> = { travado: 0, pergunta: 1, aprovar: 2 };

/**
 * F9/B14 — a ORDEM do Inbox: raia (travado < pergunta < aprovar), depois SEVERIDADE (um deploy falho não fica atrás de
 * um aviso velho de severidade média), depois idade (o mais velho primeiro; sem `since`, no fim). A régua única do
 * coletor e do board — antes eram duas cópias, e nenhuma olhava a severidade. PURE.
 */
export function compareCockpitItems(a: Pick<CockpitItem, "lane" | "severity" | "since">, z: Pick<CockpitItem, "lane" | "severity" | "since">): number {
  return (
    (LANE_RANK[a.lane] ?? 9) - (LANE_RANK[z.lane] ?? 9) ||
    (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[z.severity] ?? 9) ||
    (a.since || "9999").localeCompare(z.since || "9999")
  );
}

/** Every cockpit item on a board's cards, sorted by {@link compareCockpitItems}. */
export function boardCockpitItems(cards: Card[], config: BoardConfig, boardId: string, opts?: DemandTimingOpts): CockpitItem[] {
  return cards.flatMap((c) => cardCockpitItems(c, config, boardId, opts)).sort(compareCockpitItems);
}

// ── Stuck + Conflict items from external sources (pure projections, no IO) ───
// These are folded in at the board level from durable telemetry (stuck) and the
// in-memory merge-queue snapshot (conflict). They are kept pure (accept already-read
// data) so they stay node-unit-testable alongside cardCockpitItems.

/** The `RunnerFailure.reason` values that surface as a stuck cockpit item. 'cancelled' is DELIBERATELY
 * excluded (story-ex0139): a deliberate operator cancel is NOT a failure — it never produces a
 * RunnerFailure (so it can't be a reason here) and its telemetry outcome is filtered out upstream
 * (cockpit-collect FAILED_STATUSES), so a cancelled run is never a 'travado' demand. */
const STUCK_REASONS = new Set<RunnerFailure["reason"]>(["error", "timeout", "oom-killed", "exit", "no-op", "budget-cut"]);

/**
 * One `stuck` cockpit item per card whose most-recent telemetry run ended in failure.
 * Pure — receives the already-loaded failure list (no IO). Skips cards that are absent
 * from `cardsById` (orphan guard) or whose current status is terminal.
 *
 * `failures`: the list returned by RunnerRegistry.snapshot().failures (in-memory) OR
 * a board's telemetry records pre-filtered to failed statuses (durable). The caller
 * chooses the source; this function accepts both shapes via the common fields.
 *
 * One item per unique cardId — the most-urgent failure for that card.
 */
export function stuckItemsFromFailures(
  failures: Array<Pick<RunnerFailure, "board" | "cardId" | "reason" | "detail" | "at"> & { trigger?: string }>,
  cardsById: Map<string, Pick<Card, "id" | "title" | "status">>,
  config: Pick<BoardConfig, "statuses">,
  boardId: string,
  /** B7 — o ISO da ÚLTIMA transição de status de cada card (o ledger de transições). Uma transição DEPOIS do fim do
   *  run ⇒ o card saiu da coluna em que o run morreu: o item resolve (antes ele ficava, e «Tentar novamente» rodava a
   *  skill da coluna NOVA). */
  opts?: { lastTransitionAt?: ReadonlyMap<string, string> },
): StuckCockpitItem[] {
  // Deduplicate: one item per cardId (earliest in list = most-recent failure by caller ordering)
  const seen = new Set<string>();
  const out: StuckCockpitItem[] = [];
  for (const f of failures) {
    if (f.board !== boardId) continue;
    if (!STUCK_REASONS.has(f.reason as RunnerFailure["reason"])) continue;
    if (seen.has(f.cardId)) continue;
    const card = cardsById.get(f.cardId);
    if (!card) continue; // orphan guard
    const def = config.statuses.find((s) => s.id === card.status);
    if (def?.terminal) continue; // terminal cards never demand
    // B7 — o card mudou de status DEPOIS que o run morreu: o travado era da coluna que ele deixou.
    const moved = Date.parse(opts?.lastTransitionAt?.get(f.cardId) ?? "");
    if (f.at && Number.isFinite(moved) && moved > f.at) continue;
    seen.add(f.cardId);
    out.push({
      id: `${f.cardId}:stuck:${f.reason}`,
      kind: "stuck",
      boardId,
      cardId: f.cardId,
      cardTitle: card.title,
      status: card.status ?? null,
      lane: "travado",
      severity: "high",
      // B7 — o ISO COMPLETO do fim do run (era cortado no dia: «espera há 23h» para uma morte de minutos antes).
      since: f.at ? new Date(f.at).toISOString() : null,
      trigger: f.trigger,
      outcome: f.detail ?? f.reason,
      reason: f.reason,
    });
  }
  return out;
}

/** B6 — os findings que o SISTEMA carimba sobre a morte de um run: o diagnóstico (`run-death`, run-death.ts) e o
 *  corte por orçamento (`budget-cut`, findings.ts). São a mesma morte que o item travado já mostra. (Verificados e
 *  deixados de fora: `conductor-dispatch` — a sessão condutora não nasceu, não há run nem travado; e
 *  `deploy-settled-out-of-status` — registro forense de um deploy, não de um run.) */
const RUN_DIAGNOSTIC_FINDING_IDS: ReadonlySet<string> = new Set(["run-death", "budget-cut"]);

/**
 * UM FATO, UM ITEM: o aviso de sistema sobre a morte de um run
 * (`run-death`/`budget-cut`) sai da lista quando o MESMO card tem o item travado, e vira a evidência dele. Medido: o
 * Inbox mostrava «Destravar run» E «Triar achado · run morreu: exit», e os botões do segundo («Registrar como
 * conhecido», «Marcar resolvido») apagavam o diagnóstico sem re-tentar nada. Sem item travado (a telemetria não o
 * sustenta), o aviso continua na lista — nunca some em silêncio. PURE.
 */
export function foldRunDiagnostics(items: CockpitItem[], cardsById: ReadonlyMap<string, Pick<Card, "findings">>): CockpitItem[] {
  const stuckCards = new Set(items.filter((i) => i.kind === "stuck").map((i) => i.cardId));
  if (stuckCards.size === 0) return items;
  return items
    .filter((i) => !(i.kind === "finding" && stuckCards.has(i.cardId) && RUN_DIAGNOSTIC_FINDING_IDS.has(i.findingId)))
    .map((i) => {
      if (i.kind !== "stuck") return i;
      const findings = cardsById.get(i.cardId)?.findings ?? [];
      const diag =
        findings.find((f) => f.id === "run-death" && f.status === "open") ??
        findings.find((f) => f.id === "budget-cut" && f.status === "open");
      if (!diag) return i;
      return {
        ...i,
        evidence: {
          findingId: diag.id,
          title: diag.title,
          ...(diag.detail ? { detail: diag.detail } : {}),
          ...(diag.failureClass ? { failureClass: diag.failureClass } : {}),
        },
      };
    });
}

/**
 * One `conflict` cockpit item per merge-queue entry that is paused on a conflict or
 * gate failure. Pure — receives the already-read snapshot. Skips entries whose card is
 * absent from `cardsById` (orphan guard) or terminal.
 */
export function conflictItemsFromSnapshot(
  snapshot: MergeQueueSnapshot | undefined,
  cardsById: Map<string, Pick<Card, "id" | "title" | "status">>,
  config: Pick<BoardConfig, "statuses">,
  boardId: string,
): ConflictCockpitItem[] {
  if (!snapshot) return [];
  // Defense-in-depth (merge-train rootcause Front 3): the enqueue/move supersede invariant means at most
  // ONE live parked entry per card. But a queue persisted BEFORE the fix could still carry two — so dedup
  // by card, keeping the MOST RECENT (last in enqueue order; `entries` is appended on enqueue). This
  // guarantees the cockpit never paints a duplicate/ghost TRAVADO for a single card.
  const latestByCard = new Map<string, MergeQueueSnapshot["entries"][number]>();
  for (const entry of snapshot.entries) {
    if (entry.board !== boardId) continue;
    if (entry.status !== "conflict" && entry.status !== "gate-failed") continue;
    // WS-1.3: a card-less session entry has no card to demand FOR — and it never reaches these statuses
    // anyway (a live session's failure is `returned-to-session`, handed straight back to it). Skipping is
    // also what keeps the map honest: without it every card-less entry would collide on the key `undefined`.
    if (!entry.cardId) continue;
    latestByCard.set(entry.cardId, entry); // later iteration wins → most recent parked entry per card
  }
  const out: ConflictCockpitItem[] = [];
  // Iterate the map's [key, value]: the KEY is the cardId the filter above already proved present.
  for (const [cardId, entry] of latestByCard) {
    const card = cardsById.get(cardId);
    if (!card) continue; // orphan guard
    const def = config.statuses.find((s) => s.id === card.status);
    if (def?.terminal) continue;
    const conflictKind: ConflictCockpitItem["conflictKind"] =
      entry.status === "conflict" ? "merge-conflict" : "merge-gate-failed";
    out.push({
      id: `${cardId}:conflict:${entry.runId}`,
      kind: "conflict",
      boardId,
      cardId,
      cardTitle: card.title,
      status: card.status ?? null,
      lane: "travado",
      severity: "high",
      // F9/B14 — quando a entrada PAROU (o fim da tentativa de integração), em ISO completo.
      since: isoOf(entry.mergeEndedAt ?? entry.mergeStartedAt ?? entry.enqueuedAt),
      runId: entry.runId,
      conflictKind,
      // WS-10.5 — carry the ladder's analysis to the surface that asks the human to decide. Optional by
      // construction: `undefined` when the ladder never climbed, which the renderer reads as "no analysis".
      resolutionAnalysis: entry.resolutionAnalysis,
    });
  }
  return out;
}

/**
 * One `merge-failed` item per card whose LATEST merge-queue entry (any status; last in append order wins,
 * like conflictItemsFromSnapshot) ended `failed`. The latest-per-card rule is the anti-noise filter: a card
 * whose failed entry was SUPERSEDED by a newer run (waiting/merging/done) never surfaces — only a failure
 * that is the END of the card's integration story does. Orphan-guarded + terminal-card-guarded. NOTE: a
 * deliberate operator abort ALSO surfaces (no machine-legible field distinguishes abort from crash, and
 * discriminating by `failureReason` text would violate the "campo máquina-legível, nunca copy" convention) —
 * acceptable: the work is still off main and the offered actions (requeue/discard/escalate) stay valid. Rare.
 */
export function mergeFailedItemsFromSnapshot(
  snapshot: MergeQueueSnapshot | undefined,
  cardsById: Map<string, Pick<Card, "id" | "title" | "status">>,
  config: Pick<BoardConfig, "statuses">,
  boardId: string,
): MergeFailedCockpitItem[] {
  if (!snapshot) return [];
  const latestByCard = new Map<string, MergeQueueSnapshot["entries"][number]>();
  for (const entry of snapshot.entries) {
    if (entry.board !== boardId) continue;
    if (!entry.cardId) continue; // WS-1.3: card-less session work raises no CARD demand (see above)
    latestByCard.set(entry.cardId, entry); // later iteration wins → the card's most recent entry
  }
  const out: MergeFailedCockpitItem[] = [];
  for (const [cardId, entry] of latestByCard) {
    if (entry.status !== "failed") continue; // only a failure that is the END of the card's story
    const card = cardsById.get(cardId);
    if (!card) continue; // orphan guard
    const def = config.statuses.find((s) => s.id === card.status);
    if (def?.terminal) continue; // terminal cards never demand
    out.push({
      id: `${cardId}:merge-failed:${entry.runId}`,
      kind: "merge-failed",
      boardId,
      cardId,
      cardTitle: card.title,
      status: card.status ?? null,
      lane: "travado",
      severity: "high",
      // F9/B14 — o ISO completo do fim da tentativa (era cortado no dia).
      since: isoOf(entry.mergeEndedAt ?? entry.mergeStartedAt ?? entry.enqueuedAt),
      runId: entry.runId,
      branch: entry.branch,
      failureReason: entry.failureReason?.slice(0, 300),
    });
  }
  return out;
}

// ── Proposal + Design items from sidecars (pure projections, no IO) ──────────
// Folded in at the board level like stuck/conflict: the page reads the sidecars
// (proposals/<id>.json, wireframes/<id>.json) and hands the already-loaded docs here.

/**
 * One `proposal` item per capture container in a non-terminal status. While `capturando` the doc may
 * be absent/empty (the renderer shows "generating"); in `proposto` it carries the full proposal so the
 * human can accept (create the cards) or refine (re-run). The container card is ALWAYS the parent.
 */
export function proposalItemsFromContainers(
  cards: Card[],
  proposalsByCardId: Map<string, ProposalDoc>,
  config: Pick<BoardConfig, "statuses">,
  boardId: string,
): ProposalCockpitItem[] {
  const out: ProposalCockpitItem[] = [];
  for (const card of cards) {
    if (!card.capture) continue; // only capture containers
    const def = config.statuses.find((s) => s.id === card.status);
    if (!def || def.terminal) continue; // consumed/terminal containers never demand
    const doc = proposalsByCardId.get(card.id);
    out.push({
      id: `${card.id}:proposal`,
      kind: "proposal",
      boardId,
      cardId: card.id,
      cardTitle: card.title,
      status: card.status ?? null,
      lane: "aprovar",
      severity: "medium",
      since: doc?.updated ?? null,
      summary: doc?.summary ?? "",
      items: doc?.items ?? [],
      rounds: doc?.feedback.length ?? 0,
    });
  }
  return out;
}

/**
 * Make the cockpit lanes MUTUALLY EXCLUSIVE for a capture container, given the set of container ids that
 * have a REAL proposal sidecar (`withSidecar`). Without this, a capture whose harness-capture run FAILED
 * surfaces TWICE: as a `stuck` item (lane travado, "Tentar novamente") AND as a `proposal` placeholder
 * (lane aprovar, "Gerando proposta…") — and the placeholder LIES: it isn't generating, the run died and
 * the sidecar was never written. Per container:
 *  • has a sidecar           → keep the proposal (review it); drop its now-stale stuck item;
 *  • no sidecar + stuck      → keep the stuck (retry it); drop its "generating" placeholder;
 *  • no sidecar + not stuck  → keep the proposal ("Gerando proposta…", genuinely in-flight).
 * Pure (no IO). Only touches capture-container ids — a non-capture stuck card (a regular story whose run
 * failed) is never in `withSidecar`, so its stuck item always survives.
 */
export function dedupeCaptureLanes(
  stuck: CockpitItem[],
  proposal: ProposalCockpitItem[],
  withSidecar: ReadonlySet<string>,
): { stuck: CockpitItem[]; proposal: ProposalCockpitItem[] } {
  const stuckIds = new Set(stuck.map((s) => s.cardId));
  return {
    stuck: stuck.filter((s) => !withSidecar.has(s.cardId)),
    proposal: proposal.filter((p) => withSidecar.has(p.cardId) || !stuckIds.has(p.cardId)),
  };
}

/**
 * One `design` item per card at the "approve design" human stop (gate hasWireframe) that has canvas
 * content — legacy options OR Canvas v2 artifacts (an artifacts-only doc must surface here exactly
 * like options always did; the generic approval is deliberately skipped at this gate, so missing it
 * would strand the card with no Inbox surface at all).
 */
export function designItemsFromWireframes(
  cards: Card[],
  wireframesByCardId: Map<string, WireframeDoc>,
  config: Pick<BoardConfig, "statuses">,
  boardId: string,
): DesignCockpitItem[] {
  const out: DesignCockpitItem[] = [];
  for (const card of cards) {
    const def = config.statuses.find((s) => s.id === card.status);
    if (!def || def.terminal) continue;
    if (def.gate !== "hasWireframe") continue; // the "approve design" stop only
    const doc = wireframesByCardId.get(card.id);
    if (!doc || !hasCanvasContent(doc)) continue;
    out.push({
      id: `${card.id}:design`,
      kind: "design",
      boardId,
      cardId: card.id,
      cardTitle: card.title,
      status: card.status ?? null,
      lane: "aprovar",
      severity: "medium",
      since: doc.updated ?? null,
      journey: doc.journey,
      options: doc.options,
      artifacts: doc.artifacts,
      feedback: doc.feedback,
      chosenId: doc.chosenOptionId ?? null,
    });
  }
  return out;
}

// ── Governance items (story-ex0146) ──────────────────────────────────────────
// Folded in at board level from governance/<draftId>.json sidecars (IO in
// cockpit-collect.ts). One item per PENDING draft — approved/rejected are hidden.
// cardId = originCardId ?? "" (no orphan items; row hides "Abrir card" when empty).

/**
 * The cockpit id of a draft's item — `gov:<draftId>`. ONE construction: the Inbox builds the item with it
 * and the document pages link to that item's page with it (`inboxItemHref`), so the two can't drift apart.
 */
export function governanceItemId(draftId: string): string {
  return `gov:${draftId}`;
}

/**
 * The inverse of {@link governanceItemId}: the draftId of a governance item id, or `null`. The id comes from a URL,
 * so it must also be in the alphabet a sidecar FILENAME can have (`sanitizeId`: letters, digits, `-`) — a stray
 * character would be stripped on the way to disk and the lookup would read the draft of a DIFFERENT id.
 */
export function governanceDraftIdFromItemId(itemId: string): string | null {
  const m = /^gov:([A-Za-z0-9-]{1,100})$/.exec(itemId);
  return m ? m[1] : null;
}

/**
 * Project pending GovernanceDrafts into GovernanceCockpitItems (pure — no IO).
 * Only `pending` drafts generate an item; `approved` and `rejected` are silent.
 * `conflicts` is pre-computed by the caller (cockpit-collect reads the live config).
 */
export function governanceItemsFromDrafts(
  drafts: GovernanceDraft[],
  conflictsByDraftId: Map<string, string[]>,
  boardId: string,
  now: number = Date.now(),
  /** B8 — a recusa que aprovar receberia agora, por draft (governance-check.ts). */
  refusalByDraftId: ReadonlyMap<string, string> = new Map(),
): GovernanceCockpitItem[] {
  const out: GovernanceCockpitItem[] = [];
  for (const draft of drafts) {
    if (draft.status !== "pending") continue;
    // Vencida some da tela pelo MESMO critério que já vale para a aprovação (listApprovalRequests a
    // marca `expired` e o filtro de `pending` acima a esconde). O sidecar NÃO é apagado: continua em
    // disco, auditável, e `list_pending_changes` segue mostrando — o que muda é só parar de cobrar
    // uma decisão do operador que o tempo já tomou. Ver isGovernanceDraftStale.
    if (isGovernanceDraftStale(draft, now)) continue;
    const conflicts = conflictsByDraftId.get(draft.id) ?? [];
    out.push({
      id: governanceItemId(draft.id),
      kind: "governance",
      boardId,
      cardId: draft.origin?.cardId ?? "",
      cardTitle: draftTitle(draft),
      status: null,
      lane: "aprovar",
      severity: conflicts.length > 0 ? "high" : "medium",
      since: draft.createdAt,
      draftId: draft.id,
      changes: draft.changes,
      reason: draft.reason,
      origin: draft.origin,
      conflicts,
      ...(refusalByDraftId.get(draft.id) ? { conflictMessage: refusalByDraftId.get(draft.id) } : {}),
      ...(draft.supersedes?.length ? { supersedes: draft.supersedes } : {}),
    });
  }
  return out;
}

