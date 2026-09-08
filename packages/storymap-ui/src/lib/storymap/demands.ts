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
import { draftTitle } from "./governance";
import { hasCanvasContent } from "./design-canvas";
// type-only: apagado em runtime, então não cria ciclo (copilot/tier.ts não importa demands.ts) e mantém este
// módulo puro. O TIER é a projeção canônica de (mode, riskMatrix.deploy) — ver copilot/tier.ts.
import type { CopilotTier } from "./copilot/tier";
import type { BoardConfig, Card, DesignArtifact, DesignFeedbackEntry, FindingSeverity, GovernanceChange, GovernanceDraft, QuestionMode, QuestionOption, RiskClass, StatusDef, WireframeDoc, WireframeJourney, WireframeOption } from "./types";
import type { ProposalDoc, ProposedItem } from "./smart-capture/types";
import type { RunnerFailure } from "./runner/types";
import type { MergeQueueSnapshot } from "./runner/types";
import type { EntryResolutionAnalysis } from "./resolution-analysis";

/** F8 — id estável do finding que um deploy de produção falho carimba no card (deploy-revert.ts UPSERTA por
 *  este id). Mora AQUI, no módulo puro, porque quem precisa dele são as duas pontas: o servidor que o ESCREVE
 *  e a derivação de demanda (client-safe) que o LÊ. deploy-revert.ts re-exporta para os importadores antigos. */
export const DEPLOY_FAILURE_FINDING_ID = "deploy-failure";

/**
 * deploy-truth WS-3 — o passo que CARREGA o deploy (o "Publicando" onde o card agora ESPERA o settle),
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
   *  would lie "No ar" forever. Checked independent of status (the deploy effect may have optimistically
   *  advanced the card to a terminal step). */
  | "deploy-unsettled";

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
}

export const SEVERITY_RANK: Record<DemandSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/** Section headers for the Central de Ações (one group per demand type). */
export const DEMAND_GROUP_LABEL: Record<DemandType, string> = {
  question: "Perguntas do agente",
  blocker: "Bloqueios de revisão",
  review: "Triagem · revisar",
  gate: "Aguardando sua decisão",
  "merge-conflict": "Conflitos de merge",
  "merge-gate-failed": "Gate de integração",
  "release-aging": "Publicação atrasada",
  "deploy-unsettled": "Deploy sem confirmação",
  "deploy-failed": "Deploy falhou — não está no ar",
};

/**
 * Cockpit urgency buckets — the per-board Inbox screen groups demands into THREE lanes by what
 * the operator must DO: 🔴 travado (automation stalled — unblock it), 🟡 pergunta (an agent is
 * waiting on your answer), 🟢 aprovar (a produced result waiting on your OK to advance). This is
 * product logic, so it lives with the model and is exhaustiveness-tested — never re-inferred in a
 * component.
 */
export type CockpitGroup = "travado" | "pergunta" | "aprovar";

export const COCKPIT_GROUP_OF: Record<DemandType, CockpitGroup> = {
  blocker: "travado",
  "merge-conflict": "travado",
  "merge-gate-failed": "travado",
  question: "pergunta",
  review: "pergunta",
  gate: "aprovar",
  // Past its SLA, staged-but-unpublished code is a STALL the operator must clear (publish it), not a
  // routine post-work approval — so it surfaces in the 🔴 travado lane where stalls are triaged, its
  // escalating severity carrying the urgency.
  "release-aging": "travado",
  // A deploy that fired but never confirmed is a stall too — the service may have died mid-restart.
  "deploy-unsettled": "travado",
  // F8 — um deploy que FALHOU e reverteu o card é o stall mais grave que existe: o trabalho está pronto,
  // aprovado, e simplesmente NÃO está no ar. Vai para a lane 🔴 travado, nunca para a verde "aprovar".
  "deploy-failed": "travado",
};

export const COCKPIT_GROUP_LABEL: Record<CockpitGroup, string> = {
  travado: "Travado",
  pergunta: "Perguntas",
  aprovar: "Aprovar",
};

/** Lane order on the cockpit — most urgent first. */
export const COCKPIT_GROUP_ORDER: CockpitGroup[] = ["travado", "pergunta", "aprovar"];

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
 * (incidente acme/story-tlz0dt, 2026-07-21, card story-cvq4w0). Pure + idempotente: nada a supersedir ⇒
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
    (f) => f.status === "open" && f.severity !== "blocker" && f.id !== DEPLOY_FAILURE_FINDING_ID,
  );
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
  card: Pick<Card, "needsHumanReview">,
  def: { staging?: boolean } | null | undefined,
): boolean {
  return Boolean(card.needsHumanReview && def?.staging);
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

  // WS1.1 + deploy-truth (D-DT7) — deploy-unsettled: checked BEFORE the terminal guard. The PRIMARY case is
  // now a card STUCK in the deploy step ("Publicando"): since deploy-truth the terminal is only entered on a
  // PROVEN settle, so a settle that never arrives (dead restart, killed orch-deploy) — or one that arrived
  // without proof — leaves the card parked there with deployFiredAt uncleared. The predicate stays
  // status-INDEPENDENT on purpose: it also still catches the HISTORICAL era-otimista card that advanced to a
  // terminal before its deploy settled (deployFiredAt un-cleared on a "No ar" card) — the old detection,
  // kept for cards in transit. Only the LABEL distinguishes the two, so the operator knows which fix applies.
  if (card.deployFiredAt) {
    const age = ageHours(card.deployFiredAt, opts?.now ?? Date.now());
    const thresholdMin = opts?.deployUnsettledMinutes ?? DEPLOY_UNSETTLED_MINUTES_DEFAULT;
    if (age !== null && age * 60 >= thresholdMin) {
      out.push({
        ...base,
        type: "deploy-unsettled",
        severity: "high",
        label: isDeployStep(def)
          ? "Card preso em Publicando — deploy disparado sem confirmação (settle não chegou)"
          : "Deploy disparado sem confirmação — verifique o serviço",
        since: card.deployFiredAt,
      });
    }
  }

  // F8 — deploy FALHOU: como o deploy-unsettled acima, é checado ANTES do guard de terminal. Um revert que não
  // conseguiu landar (board sem coluna `release`) deixa o card TERMINAL carregando o finding aberto — que é
  // justamente o caso em que a mentira "está no ar" custa mais caro. A demanda tem de sobreviver ao early-return.
  const deployFail = openDeployFailure(card);
  if (deployFail) {
    out.push({
      ...base,
      type: "deploy-failed",
      severity: "critical",
      label: deployFail.title ?? "Deploy de produção falhou — o código não está no ar",
    });
  }

  if (!def || def.terminal) return out;

  const open = openQuestions(card);
  if (open.length) {
    const since = open.map((q) => q.askedAt).filter((d): d is string => Boolean(d)).sort()[0] ?? null;
    out.push({
      ...base,
      type: "question",
      severity: "high",
      count: open.length,
      label: `Responder ${open.length} pergunta${open.length === 1 ? "" : "s"}`,
      since,
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
    });
  }

  if (needsTriageReview(card, def)) {
    out.push({ ...base, type: "review", severity: "medium", label: "Revisar item da triagem (baixa confiança)" });
  }

  // Human GATE: the card is parked in a non-terminal manual step the cascade won't auto-advance. We
  // surface it ONLY when an agent has ALREADY PRODUCED WORK on the card (hasProducedWork) — i.e. it's
  // an APPROVAL the automation is waiting on (aprovar design/entrega, publicar). A manual step the
  // card reached with NOTHING run yet (triage intake, "a fazer" after estimate) is BACKLOG the
  // operator drives on the board, NOT a pilotage demand — surfacing it here is exactly the noise that
  // turned "precisa de você" into a mirror of the backlog (the cockpit is exceptions-of-the-running-
  // automation, not a to-do). `label` is the step's own name (board-agnostic, no hardcoded map),
  // e.g. "Aprovar entrega", "Aprovar design", "Publicar".
  if (def.autorun !== true && hasProducedWork(card)) {
    out.push({ ...base, type: "gate", severity: "medium", label: def.name ?? "Decisão pendente" });
  }

  // story-ql5mjm: the `descontinuar` executor is now autorun:true + its lane hidden, so the generic gate
  // demand above is SKIPPED and a retire card paused on the IRREVERSIBLE data-deletion approval
  // (excluir-tudo) would be invisible on every surface. Surface that ONE approval ALWAYS — it is the
  // single step the operator MUST confirm before production data is wiped. (Questions/blockers already
  // surface via their own non-autorun-gated branches above; only this card-field gate was orphaned.)
  if (card.mode === "retire" && card.retirement?.level === "excluir-tudo" && card.retirement.dataDeletionApproved === false) {
    out.push({ ...base, type: "gate", severity: "high", label: "Aprovar exclusão de dados (irreversível)" });
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
      });
    }
  }

  return out;
}

/** Every pending card demand on a board, sorted by severity then age (oldest-first). */
export function boardCardDemands(cards: Card[], config: BoardConfig, boardId: string, opts?: DemandTimingOpts): Demand[] {
  return cards
    .flatMap((c) => cardDemands(c, config, boardId, opts))
    .sort((a, z) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[z.severity] || (a.since || "9999").localeCompare(z.since || "9999"));
}

/** True when a card has ≥1 pending human demand (drives the per-card badge). */
export function hasDemand(card: Card, config: BoardConfig, opts?: DemandTimingOpts): boolean {
  return cardDemands(card, config, "", opts).length > 0;
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
   *  não era item de nada e o tick NUNCA o via (acme/story-novo-item: 6 avisos, 0 itens, o board dizendo
   *  "nada acionável"). Não travar não é o mesmo que não ser trabalho: um aviso aberto para sempre é
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
  | "merge-failed";

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
}

/** 🟢 F8 — um gate manual DO BOARD: a automação produziu trabalho e espera alguém empurrar ("Aprovar entrega",
 *  "Publicar"). É a fila que um orquestrador de ponta a ponta trabalha. Separado de {@link ApprovalCockpitItem}
 *  — que é o pedido de aprovação DO PRÓPRIO COPILOTO — porque conflati-los faria o tick acordar por causa de si. */
export interface GateCockpitItem extends CockpitItemBase {
  kind: "gate";
  /** the gate's label = the manual step name ("Aprovar entrega", "Publicar"). */
  gateLabel: string;
}

/** 🟢 O copiloto PEDIU sua aprovação para uma ação `ask` da matriz de risco (approvals.ts). Espera VOCÊ. */
export interface ApprovalCockpitItem extends CockpitItemBase {
  kind: "approval";
  /** the gate's label — aqui, "Copiloto pede: <tool> (<classe>)". */
  gateLabel: string;
  /** WS-3 §3.5 (D12) — mirror of the ApprovalRequest sidecar (approvals.ts) for an informed decision:
   *  fim da aprovação às cegas. Absent on the `<cardId>:data-deletion` fallback item (no sidecar there). */
  tool?: string;
  /** canonical JSON (string, ≤2KB — truncated on creation, approvals.ts:112). Render verbatim. */
  args?: string;
  riskClass?: RiskClass;
  requestedAt?: string;
  expiresAt?: string;
  note?: string;
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
}

/** 🔴 WS-5 — um deploy FIRED (deployFiredAt) cujo settle-webhook silenciou além do SLA. Read-only +
 *  escalação (D6): NUNCA oferecer "settle manual" 1-clique — a semântica do settle é do webhook. */
export interface DeployUnsettledCockpitItem extends CockpitItemBase {
  kind: "deploy-unsettled";
  /** ISO do disparo (o campo do card; limpo pelo settle — deploy-revert.ts). */
  deployFiredAt: string;
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
  | MergeFailedCockpitItem;

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
  // → re-drive/escalar. PROMOVIDO ao Copiloto por decisão do Operador (2026-07-16), fechando a governança que a
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
 * buys another no-op (the self-feeding loop of the 2026-07-15 incident). It stays VISIBLE to the human on
 * Inbox (travado lane — it may be a real symptom, e.g. a phantom-done card) but the autonomous tick
 * leaves it for the human after the first run. Keyed on the machine `outcome` (the telemetry RunOutcome the
 * stuck projection carries), never on freeform text.
 */
const NON_ACTIONABLE_STUCK_OUTCOMES: ReadonlySet<string> = new Set(["no-op"]);

/** True when the autonomous copiloto tick could act on this item AT `tier` (see {@link KIND_AUTONOMY}). O tier
 *  é OBRIGATÓRIO de propósito: um default aqui seria uma segunda verdade sobre "o que ele pode", divergindo da
 *  matriz que o guard lê — o mesmo motivo que fez o tier ser uma PROJEÇÃO da matriz, e não um campo novo. PURE. */
export function isCopilotActionable(item: CockpitItem, tier: CopilotTier): boolean {
  if (!copilotActionableKinds(tier).has(item.kind)) return false;
  // WS-5.1 (D9): a stuck item derived from a `no-op` run leaves the actionable set — see
  // {@link NON_ACTIONABLE_STUCK_OUTCOMES}. Only `stuck` carries an `outcome`; other kinds are unaffected.
  // INVARIANTE DE TIER (como `approval`): vale TAMBÉM no Autônomo. "Re-drivar um no-op compra outro no-op" é um
  // FATO sobre o playbook, não falta de poder — mais autonomia não torna a re-tentativa certa, só mais cara.
  if (item.kind === "stuck" && item.outcome != null && NON_ACTIONABLE_STUCK_OUTCOMES.has(item.outcome)) {
    return false;
  }
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

  // F8 — deploy falhou: ANTES do guard de terminal (ver cardDemands). É o item mais urgente que um board pode
  // ter — o trabalho está pronto, aprovado, e NÃO está no ar — e é o que o copiloto autônomo consome p/ re-publicar.
  const deployFail = openDeployFailure(card);
  if (deployFail) {
    out.push({
      ...base,
      id: `${card.id}:deploy-failed`,
      kind: "deploy-failed",
      lane: "travado",
      severity: "high",
      findingId: deployFail.id,
      title: deployFail.title,
      lens: deployFail.lens,
      suggestion: deployFail.suggestion,
    });
  }

  // WS-5 (D9) + deploy-truth (D-DT7) — deploy-unsettled: BEFORE the terminal guard (like deploy-failed).
  // Primary case since deploy-truth: a card STUCK in the deploy step ("Publicando") whose settle never
  // arrived/proved — the terminal is settle-gated now, so the card parks there with deployFiredAt uncleared.
  // Kept status-INDEPENDENT so the historical era-otimista card (terminal with an un-cleared stamp) is still
  // caught. Same predicate/threshold as the cardDemands twin — the two derivations must never disagree.
  if (card.deployFiredAt) {
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
    });
  }

  for (const f of openBlockers(card)) {
    out.push({
      ...base,
      id: `${card.id}:b:${f.id}`,
      kind: "blocker",
      lane: "travado",
      severity: "high",
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
      severity: f.severity as Exclude<FindingSeverity, "blocker">,
      findingId: f.id,
      title: f.title,
      lens: f.lens,
      suggestion: f.suggestion,
      findingSeverity: f.severity as Exclude<FindingSeverity, "blocker">,
    });
  }

  if (needsTriageReview(card, def)) {
    out.push({ ...base, id: `${card.id}:review`, kind: "review", lane: "pergunta", severity: "medium" });
  }

  // approval: a post-work manual gate (hasProducedWork + non-autorun) — the automation waits your OK.
  // The "approve design" stop (gate hasWireframe) is covered by the richer `design` item (board-level
  // folding from the wireframe sidecar), so skip the generic approval there to avoid a duplicate.
  if (def.autorun !== true && def.gate !== "hasWireframe" && hasProducedWork(card)) {
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
      gateLabel: def.name ?? "Decisão pendente",
    });
  }

  // story-ql5mjm: the IRREVERSIBLE data-deletion approval of a retire (excluir-tudo) — surfaced ALWAYS,
  // independent of the autorun gate above, because the `descontinuar` executor is now autorun + hidden
  // and this card-field gate would otherwise be unreachable (the operator could never approve the wipe).
  if (card.mode === "retire" && card.retirement?.level === "excluir-tudo" && card.retirement.dataDeletionApproved === false) {
    out.push({
      ...base,
      id: `${card.id}:data-deletion`,
      kind: "approval",
      lane: "aprovar",
      severity: "high",
      gateLabel: "Aprovar exclusão de dados (irreversível)",
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

const LANE_RANK: Record<CockpitGroup, number> = { travado: 0, pergunta: 1, aprovar: 2 };

/** Every cockpit item on a board's cards, sorted by lane urgency then age (oldest-first). */
export function boardCockpitItems(cards: Card[], config: BoardConfig, boardId: string, opts?: DemandTimingOpts): CockpitItem[] {
  return cards
    .flatMap((c) => cardCockpitItems(c, config, boardId, opts))
    .sort((a, z) => LANE_RANK[a.lane] - LANE_RANK[z.lane] || (a.since || "9999").localeCompare(z.since || "9999"));
}

// ── Stuck + Conflict items from external sources (pure projections, no IO) ───
// These are folded in at the board level from durable telemetry (stuck) and the
// in-memory merge-queue snapshot (conflict). They are kept pure (accept already-read
// data) so they stay node-unit-testable alongside cardCockpitItems.

/** The `RunnerFailure.reason` values that surface as a stuck cockpit item. 'cancelled' is DELIBERATELY
 * excluded (story-vbkazs): a deliberate operator cancel is NOT a failure — it never produces a
 * RunnerFailure (so it can't be a reason here) and its telemetry outcome is filtered out upstream
 * (cockpit-collect FAILED_STATUSES), so a cancelled run is never a 'travado' demand. */
const STUCK_REASONS = new Set<RunnerFailure["reason"]>(["error", "timeout", "oom-killed", "exit", "no-op"]);

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
      since: f.at ? new Date(f.at).toISOString().slice(0, 10) : null,
      trigger: f.trigger,
      outcome: f.detail ?? f.reason,
    });
  }
  return out;
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
      since: null,
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
      since: entry.mergeEndedAt ? new Date(entry.mergeEndedAt).toISOString().slice(0, 10) : null,
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

// ── Governance items (story-w9n03r) ──────────────────────────────────────────
// Folded in at board level from governance/<draftId>.json sidecars (IO in
// cockpit-collect.ts). One item per PENDING draft — approved/rejected are hidden.
// cardId = originCardId ?? "" (no orphan items; row hides "Abrir card" when empty).

/**
 * Project pending GovernanceDrafts into GovernanceCockpitItems (pure — no IO).
 * Only `pending` drafts generate an item; `approved` and `rejected` are silent.
 * `conflicts` is pre-computed by the caller (cockpit-collect reads the live config).
 */
export function governanceItemsFromDrafts(
  drafts: GovernanceDraft[],
  conflictsByDraftId: Map<string, string[]>,
  boardId: string,
): GovernanceCockpitItem[] {
  const out: GovernanceCockpitItem[] = [];
  for (const draft of drafts) {
    if (draft.status !== "pending") continue;
    const conflicts = conflictsByDraftId.get(draft.id) ?? [];
    out.push({
      id: `gov:${draft.id}`,
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
    });
  }
  return out;
}

