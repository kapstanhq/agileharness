// MUDAR UM CARD DE BOARD — a parte PURA: quando pode, e o que o card vira no board novo.
// O IO (locks, arquivos, sidecars, ledgers) mora em runner/card-transfer-service.ts.
//
// Um alvo com vários boards acumulava cards no board errado: a triagem só sabia aceitar ou descartar onde o card caiu, e
// os consertos automáticos herdavam o board do card de origem. Sem um jeito de mudar de board, a única saída era recriar
// o card à mão — perdendo histórico, achados, perguntas e custo. A mudança mantém o MESMO id e leva tudo junto.
//
// O que é regra (e não opinião):
//   • só stories e ideias mudam de board — atividades e passos são a estrutura do mapa de um board;
//   • não muda quem está sendo trabalhado AGORA (run, condutor, reserva, sessão com árvore, fila de integração ou
//     publicação em voo) nem quem ancora outros cards — mudar por baixo de um trabalho em curso o perderia;
//   • o status fica quando o board novo tem o mesmo passo; senão o card entra pela porta de entrada dele, com aviso;
//   • a âncora no mapa (parent/serves) e os vínculos são do board antigo: com uma âncora informada e válida no board novo
//     ela é usada; senão o card entra pela TRIAGEM do board novo (a quarentena é o único lugar onde um card sem âncora é
//     representável — a mesma régua de hierarquia da escrita, gate-core `placementViolation`), com um achado pedindo a
//     âncora — nunca um id que não existe aqui. Board sem Triagem e sem âncora válida ⇒ recusa;
//   • a trilha (`transfers`) registra de onde veio, quem mudou, por quê e a âncora que ficou para trás;
//   • não muda quem o condutor dirige (mesmo estacionado à espera do dono — o `driver` é o que reabre o condutor quando o
//     dono responde) nem quem tem a pergunta do TETO de rodadas aberta (a resposta é do dono, no board onde ela está);
//   • quem muda é um AGENTE ou o juiz: o card só mantém o passo quando o regime do destino é IGUAL OU MAIS ESTRITO
//     (modo de autonomia, publicação, ritmo, escopo de tipos e matriz de risco); num destino mais permissivo ele entra
//     pela TRIAGEM de lá, para ser julgado de novo — mudar de board não é um jeito de fugir de uma regra do dono. O
//     OPERADOR (a tela) mantém o passo sempre: é ele quem decide;
//   • entrar na Triagem do destino zera o veredito antigo do juiz (fica na trilha), para o juiz de lá julgar de novo; em
//     modo humano, o card pede revisão humana.

import { effectiveAutonomy, proxySettings } from "./autonomy";
import { budgetFigures } from "./cost-impact";
import { ownerClassesOf } from "./owner-classes";
import { placementViolation } from "./gate-core";
import { releaseModeOf } from "./release-policy";
import { paceRank, type PaceLevel } from "./runner/board-pace";
import { dispositionFor } from "./runner/orchestrator-policy";
import { hasOpenRoundsCapQuestion } from "./runner/review-rounds";
import { RISK_CLASSES } from "./types";
import type { BoardConfig, Card, CardLink, CardTransfer, Finding, RiskDisposition, TransferEvidence } from "./types";

/** O achado que pede a âncora no board novo. */
export const TRANSFER_ANCHOR_FINDING_ID = "transfer-anchor";

/** O que está trabalhando no card AGORA — o serviço mede, a regra decide. */
export interface TransferBusy {
  run?: boolean;
  claim?: boolean;
  session?: boolean;
  mergeQueue?: boolean;
  publishing?: boolean;
}

export interface TransferRefusalInput {
  fromBoard: string;
  toBoard: string;
  /** o card no board de origem (null = não existe lá). */
  card: Card | null;
  /** a config do board de destino (null = não existe). */
  toConfig: Pick<BoardConfig, "id" | "statuses"> | null;
  /** já há um card com este id no destino. */
  toHasCard: boolean;
  busy: TransferBusy;
  /** os cards do board de origem que se ancoram neste (parent/serves). */
  dependents: readonly Pick<Card, "id" | "title">[];
}

/** Por que este card não pode mudar de board agora — ou null. A MESMA frase do botão, da action e da tool. PURA. */
export function transferRefusal(i: TransferRefusalInput): string | null {
  if (!i.toBoard.trim()) return "diga para qual board o card vai";
  if (i.fromBoard === i.toBoard) return "o card já está neste board";
  if (!i.toConfig) return `o board «${i.toBoard}» não existe`;
  if (!i.card) return "o card não existe no board de origem";
  if (i.card.type !== "story" && i.card.type !== "idea") {
    return "só histórias e ideias mudam de board — atividades e passos são a estrutura do mapa (mude os cards um a um)";
  }
  if (i.toHasCard) return `já existe um card «${i.card.id}» no board «${i.toBoard}» — o id não pode se repetir`;
  if (i.busy.run) return "há um agente rodando neste card agora — espere ele terminar";
  if (i.busy.claim) return "o card está reservado por um agente — espere a reserva terminar ou libere-a";
  if (i.busy.session) return "há uma sessão de trabalho aberta neste card — encerre-a antes (o trabalho dela é do board atual)";
  if (i.busy.mergeQueue) return "o código deste card está na fila de integração — espere a integração terminar";
  if (i.busy.publishing) return "o card está sendo publicado — espere a publicação assentar";
  if (i.card.routing?.driver) {
    return "o card é conduzido por um agente (mesmo estacionado à espera do dono) — encerre a condução antes de mudar de board, ou o condutor não reabre quando o dono responder";
  }
  if (hasOpenRoundsCapQuestion(i.card)) {
    return "o card tem a pergunta do teto de rodadas de revisão aberta — a resposta é do dono, neste board; mude-o depois que ele responder";
  }
  if (i.dependents.length) {
    const sample = i.dependents
      .slice(0, 3)
      .map((d) => `«${d.title}»`)
      .join(", ");
    return `${i.dependents.length} card(s) se ancoram neste (${sample}${i.dependents.length > 3 ? "…" : ""}) — mude-os primeiro, ou ancore-os em outro`;
  }
  return null;
}

/** O regime de um board para ESTE card: o que a mudança de board compara. */
export interface TransferRegime {
  config: Partial<Pick<BoardConfig, "autonomy" | "release" | "orchestrator">>;
  /** o ritmo em vigor no board. */
  pace: PaceLevel;
  /** o escopo de tipos do board admite este card? */
  admits: boolean;
}

const DISPOSITION_RANK: Record<RiskDisposition, number> = { auto: 0, ask: 1, never: 2 };
/** O copiloto mais solto: `autonomous` age sozinho, `paired` só com uma pessoa, `off` não age. */
const ORCHESTRATOR_RANK: Record<string, number> = { off: 0, paired: 1, autonomous: 2 };

/**
 * Onde o board de destino é MAIS PERMISSIVO que o de origem para este card — em português, vazio = igual ou mais
 * estrito. É o que faz a mudança de board de um agente entrar pela Triagem em vez de manter o passo. PURA.
 */
export function transferRegimeLoosening(card: Pick<Card, "autonomyMode">, from: TransferRegime, to: TransferRegime): string[] {
  const out: string[] = [];
  if (effectiveAutonomy(card, from.config).mode === "human" && effectiveAutonomy(card, to.config).mode === "ultra") {
    out.push("lá o sistema decide sozinho o que aqui o dono aprova passo a passo");
  }
  if (releaseModeOf(from.config) === "manual" && releaseModeOf(to.config) === "auto") out.push("lá a publicação é pedida sozinha");
  if (paceRank(to.pace) > paceRank(from.pace)) out.push(`lá o ritmo é mais rápido (${to.pace} em vez de ${from.pace})`);
  if (!from.admits && to.admits) out.push("lá o escopo de tipos admite este card, aqui não");
  const looser = RISK_CLASSES.filter((c) => DISPOSITION_RANK[dispositionFor(to.config.orchestrator, c)] < DISPOSITION_RANK[dispositionFor(from.config.orchestrator, c)]);
  if (looser.length) out.push(`lá a matriz de risco libera mais (${looser.join(", ")})`);
  // o copiloto lá age com menos gente olhando
  if ((ORCHESTRATOR_RANK[to.config.orchestrator?.mode ?? "off"] ?? 0) > (ORCHESTRATOR_RANK[from.config.orchestrator?.mode ?? "off"] ?? 0)) {
    out.push(`lá o copiloto age mais sozinho (${to.config.orchestrator?.mode} em vez de ${from.config.orchestrator?.mode ?? "off"})`);
  }
  // uma classe do dono que existe aqui e não lá: lá o sistema decide o que aqui é do dono
  const toClasses = new Set(ownerClassesOf(to.config).map((c) => c.id));
  const dropped = ownerClassesOf(from.config).filter((c) => !toClasses.has(c.id)).map((c) => c.id);
  if (dropped.length) out.push(`lá não são do dono: ${dropped.join(", ")}`);
  // um teto de gasto maior (ou ausente onde aqui há um) deixa o sistema gastar mais sem perguntar
  const fb = budgetFigures(from.config.autonomy?.budget);
  const tb = budgetFigures(to.config.autonomy?.budget);
  for (const k of ["cash", "infra"] as const) {
    const f = fb[k];
    const t = tb[k];
    if (f != null && (t == null || t > f)) out.push(`lá o teto de gasto (${k}) é maior`);
  }
  // uma amostra de auditoria técnica menor revê menos entregas
  if (proxySettings(to.config).technicalAuditSampleRate < proxySettings(from.config).technicalAuditSampleRate) out.push("lá a auditoria técnica revê menos entregas");
  return out;
}

/** O retrato da evidência do pipeline que o card carrega (só o que existe). PURA. */
export function transferEvidenceOf(card: Card): TransferEvidence {
  const e: TransferEvidence = {};
  if (card.qaPassed) e.qaPassed = true;
  if (card.qaRanAt) e.qaRanAt = card.qaRanAt;
  if (card.qaCommit) e.qaCommit = card.qaCommit;
  if (card.qaEvidence) e.hadQaEvidence = true;
  if (card.reviewedAt) e.reviewedAt = card.reviewedAt;
  if (card.reviewCommit) e.reviewCommit = card.reviewCommit;
  if (card.techPlanReady) e.techPlanReady = true;
  if (card.wireframeChosen) e.wireframeChosen = card.wireframeChosen;
  if (card.buildEvidence) e.hadBuildEvidence = true;
  const done = (card.tasks ?? []).filter((t) => t.done).map((t) => t.id);
  if (done.length) e.tasksDone = done;
  return e;
}

/** O card sem a evidência que faria os gates passarem (os fatos do código — integração, publicação — ficam). PURA. */
export function clearedEvidence(card: Card): Partial<Card> {
  return {
    qaPassed: undefined,
    qaRanAt: null,
    qaCommit: null,
    qaEvidence: undefined,
    reviewedAt: null,
    reviewCommit: null,
    techPlanReady: undefined,
    wireframeChosen: null,
    buildEvidence: undefined,
    tasks: (card.tasks ?? []).map((t) => (t.done ? { ...t, done: false } : t)),
  };
}

/**
 * O card entrou na Triagem por uma mudança de board FORÇADA e ainda não foi julgado lá? Então só o juiz do destino ou o
 * operador o tiram de lá — o move_card de um agente recusa. PURA.
 */
export function heldByForcedTransfer(card: Pick<Card, "status" | "transfers" | "triageDecision">, config: Pick<BoardConfig, "statuses">): boolean {
  const staging = config.statuses.find((s) => s.staging)?.id;
  const last = card.transfers?.[card.transfers.length - 1];
  return !!staging && card.status === staging && last?.forced === true && !card.triageDecision;
}

/** A porta de entrada de um board: a Triagem (o passo `staging`), senão o primeiro passo do pipeline. PURA. */
export function entryStatusOf(config: Pick<BoardConfig, "statuses">): string | null {
  return config.statuses.find((s) => s.staging)?.id ?? config.statuses[0]?.id ?? null;
}

export interface TransferPlanInput {
  card: Card;
  fromBoard: string;
  fromName?: string;
  toBoard: string;
  toName?: string;
  /** os cards do board de origem (para o título da âncora que fica para trás). */
  fromCards: readonly Card[];
  toConfig: Pick<BoardConfig, "statuses"> & Partial<Pick<BoardConfig, "autonomy">>;
  /**
   * Por que o card NÃO mantém o passo (o regime do destino é mais permissivo e quem muda é um agente — ver
   * {@link transferRegimeLoosening}): presente ⇒ o card entra pela Triagem do destino (ou a porta de entrada dele).
   */
  forceEntry?: readonly string[];
  /** os cards do board de destino (âncora e vínculos só valem com ids daqui). */
  toCards: readonly Card[];
  /** a âncora pedida no board novo (um passo para história de usuário; história/passo/atividade para uma entrega). */
  anchor?: string | null;
  by: string;
  reason?: string | null;
  /** ISO. */
  at: string;
}

export interface TransferPlan {
  /** quando o card não pode existir no board novo (sem âncora válida e sem Triagem para entrar) — nada é escrito. */
  error?: string;
  card: Card;
  /** o que o card perdeu ou mudou na passagem — vai para o retorno da ação e para o registro. */
  warnings: string[];
  /** os vínculos que apontavam para cards do board antigo (não existem no novo). */
  droppedLinks: CardLink[];
  fromStatus: string | null;
  toStatus: string | null;
}

const isUserStory = (c: Pick<Card, "type" | "storyType">) => c.type === "story" && (c.storyType == null || c.storyType === "user");

/** A âncora pedida é aceitável para este card no board novo? Devolve o campo a gravar, ou o motivo. */
function anchorFor(card: Card, anchorId: string, toCards: readonly Card[]): { parent: string } | { serves: string } | { error: string } {
  const target = toCards.find((c) => c.id === anchorId);
  if (!target) return { error: `a âncora «${anchorId}» não existe no board de destino` };
  if (card.type === "idea") return { error: "ideia não tem âncora no mapa" };
  if (isUserStory(card)) {
    return target.type === "step" ? { parent: target.id } : { error: `uma história de usuário mora sob um PASSO — «${target.title}» não é um passo` };
  }
  return isUserStory(target) ? { serves: target.id } : { error: `uma entrega serve uma HISTÓRIA DE USUÁRIO — «${target.title}» não é uma` };
}

/** O card como ele fica no board novo. Chame {@link transferRefusal} antes. PURA. */
export function planCardTransfer(i: TransferPlanInput): TransferPlan {
  const { card } = i;
  const warnings: string[] = [];
  const toIds = new Set(i.toCards.map((c) => c.id));
  const fromById = new Map(i.fromCards.map((c) => [c.id, c]));

  // ── o status: o mesmo passo se o board novo o tem; senão a porta de entrada dele ──
  const fromStatus = card.status ?? null;
  let toStatus = fromStatus;
  if (card.type !== "idea" && fromStatus && !i.toConfig.statuses.some((s) => s.id === fromStatus)) {
    toStatus = entryStatusOf(i.toConfig);
    warnings.push(`o board de destino não tem o passo «${fromStatus}» — o card entrou por «${toStatus ?? "—"}»`);
  }
  const statusDef = (id: string | null) => i.toConfig.statuses.find((s) => s.id === id);
  const staging = i.toConfig.statuses.find((s) => s.staging)?.id ?? null;
  // Um agente mudando para um board mais permissivo: o card entra pela Triagem de lá, para ser julgado de novo — e a
  // evidência do pipeline que os gates leem (QA, revisão, plano, tasks feitas, design escolhido, prova de build) é
  // zerada: refeita no regime de lá, não herdada do daqui. O retrato fica na trilha.
  let forced = false;
  let evidencePatch: Partial<Card> = {};
  let previousEvidence: TransferEvidence | undefined;
  if (card.type !== "idea" && i.forceEntry?.length) {
    const door = staging ?? entryStatusOf(i.toConfig);
    if (door && toStatus !== door) {
      warnings.push(`o board de destino é mais permissivo (${i.forceEntry.join("; ")}) — o card entrou por «${door}» para ser julgado de novo lá`);
      toStatus = door;
    }
    forced = true;
    previousEvidence = transferEvidenceOf(card);
    evidencePatch = clearedEvidence(card);
    if (Object.keys(previousEvidence).length) warnings.push("a evidência do pipeline (QA, revisão, plano, tasks feitas) foi zerada — o board de destino a refaz");
  }

  // ── a âncora: só ids do board novo ──
  const oldAnchorId = card.serves ?? card.parent ?? null;
  const oldAnchorMoves = !!oldAnchorId && !toIds.has(oldAnchorId);
  let anchorPatch: Partial<Card> = {};
  let needsAnchor = false;
  if (i.anchor) {
    const a = anchorFor(card, i.anchor, i.toCards);
    if ("error" in a) {
      warnings.push(`${a.error} — o card ficou sem lugar no mapa`);
      needsAnchor = card.type !== "idea";
      anchorPatch = { parent: null, serves: null };
    } else {
      anchorPatch = { parent: "parent" in a ? a.parent : card.parent && toIds.has(card.parent) ? card.parent : null, serves: "serves" in a ? a.serves : null };
    }
  } else if (oldAnchorMoves || (card.parent && !toIds.has(card.parent))) {
    anchorPatch = { parent: null, serves: null };
    needsAnchor = card.type !== "idea";
    if (needsAnchor) warnings.push("a âncora no mapa era do board antigo — o card ficou sem lugar até alguém escolher uma no board novo");
  }

  // ── os vínculos: os que apontam para fora do board novo caem (ficam registrados no corpo) ──
  const droppedLinks = card.links.filter((l) => !toIds.has(l.to));
  const links = card.links.filter((l) => toIds.has(l.to));
  if (droppedLinks.length) warnings.push(`${droppedLinks.length} vínculo(s) apontavam para cards do board antigo — registrados no corpo do card`);

  const previousAnchor = oldAnchorMoves && oldAnchorId ? { id: oldAnchorId, ...(fromById.get(oldAnchorId)?.title ? { title: fromById.get(oldAnchorId)!.title } : {}) } : undefined;
  const transfer: CardTransfer = {
    from: i.fromBoard,
    to: i.toBoard,
    at: i.at,
    by: i.by,
    ...(i.reason?.trim() ? { reason: i.reason.trim().slice(0, 600) } : {}),
    fromStatus,
    ...(previousAnchor ? { previousAnchor } : {}),
  };

  // ── o corpo: de onde veio, a âncora antiga e os vínculos que ficaram para trás ──
  const fromLabel = i.fromName ? `«${i.fromName}» (${i.fromBoard})` : `«${i.fromBoard}»`;
  const linkLine = (l: CardLink) => `- ${l.rel}: ${l.to}${fromById.get(l.to)?.title ? ` — ${fromById.get(l.to)!.title}` : ""}`;
  const section = [
    `## Veio do board ${fromLabel}`,
    "",
    `- Em ${i.at.slice(0, 10)}, por ${i.by}${i.reason?.trim() ? `: ${i.reason.trim()}` : ""}.`,
    ...(fromStatus ? [`- Status no board de origem: ${fromStatus}.`] : []),
    ...(previousAnchor ? [`- Âncora no mapa de lá: ${previousAnchor.id}${previousAnchor.title ? ` — ${previousAnchor.title}` : ""}.`] : []),
    ...(droppedLinks.length ? ["- Vínculos com cards de lá:", ...droppedLinks.map(linkLine)] : []),
  ].join("\n");
  const body = [(card.body ?? "").trim(), section].filter(Boolean).join("\n\n");

  // ── o achado que pede a âncora ──
  const findings: Finding[] = (card.findings ?? []).filter((f) => f.id !== TRANSFER_ANCHOR_FINDING_ID);
  if (needsAnchor) {
    findings.push({
      id: TRANSFER_ANCHOR_FINDING_ID,
      lens: "general",
      severity: "medium",
      status: "open",
      title: "Escolha o lugar deste card no mapa do board novo",
      detail: previousAnchor
        ? `No board ${fromLabel} ele ficava sob «${previousAnchor.title ?? previousAnchor.id}». Ancore-o num passo ou numa história deste board.`
        : "Ancore-o num passo ou numa história deste board.",
    });
  }

  // O condutor e as reservas são do board antigo: o board novo decide quem conduz (o resto do roteamento fica).
  let routing = card.routing;
  if (routing && "driver" in routing) {
    const { driver: _driver, ...rest } = routing;
    routing = rest;
  }

  // Sem lugar no mapa, um card só é representável na quarentena (ou num passo terminal): entra pela Triagem de lá.
  if (needsAnchor && toStatus && !statusDef(toStatus)?.terminal && !statusDef(toStatus)?.staging) {
    if (!staging) {
      return {
        error: "o board de destino não tem Triagem para receber um card sem lugar no mapa — informe a âncora (o passo ou a história de lá)",
        card,
        warnings,
        droppedLinks,
        fromStatus,
        toStatus,
      };
    }
    warnings.push(`sem lugar no mapa do board novo, o card entrou pela Triagem de lá («${staging}») — ganhe uma âncora e ele segue de onde estava`);
    toStatus = staging;
  }

  // Entrar na Triagem do destino é ser julgado DE NOVO lá: o veredito antigo do juiz fica na trilha (`transfers`), não no
  // card — senão o juiz de lá o ignora (ele só pega quem não tem veredito) e nada aparece a ninguém. Em modo humano, o
  // card pede revisão humana.
  const entersTriage = card.type !== "idea" && !!staging && toStatus === staging;
  const humanMode = effectiveAutonomy(card, i.toConfig).mode === "human";
  const trail: CardTransfer = {
    ...transfer,
    ...(entersTriage && card.triageDecision ? { previousTriage: { verdict: card.triageDecision.verdict, reason: card.triageDecision.reason.slice(0, 600) } } : {}),
    ...(forced ? { forced: true } : {}),
    ...(previousEvidence && Object.keys(previousEvidence).length ? { previousEvidence } : {}),
  };
  const next: Card = {
    ...card,
    ...evidencePatch,
    ...(entersTriage ? { triageDecision: undefined, ...(humanMode ? { needsHumanReview: true } : {}) } : {}),
    status: toStatus,
    ...anchorPatch,
    ...(needsAnchor ? { unplaced: true } : {}),
    ...(anchorPatch.parent || anchorPatch.serves ? { unplaced: undefined } : {}),
    links,
    body,
    findings,
    routing,
    transfers: [...(card.transfers ?? []), trail],
  };
  // A MESMA régua de hierarquia da escrita (write.ts `assertPlacement`): o card que sai daqui é representável lá.
  const byId = new Map(i.toCards.map((c) => [c.id, c]));
  const violation = placementViolation(next, (id: string) => byId.get(id) ?? null, i.toConfig as BoardConfig);
  if (violation) return { error: `${violation.message} — informe uma âncora válida do board de destino`, card, warnings, droppedLinks, fromStatus, toStatus };
  return { card: next, warnings, droppedLinks, fromStatus, toStatus };
}
