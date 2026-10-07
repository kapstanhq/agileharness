// A DECISÃO DO DONO ESPERA. PURA (zero IO).
//
// Uma decisão que só o dono toma e que ele ainda não respondeu ESPERA para sempre: não vence, não vira a opção
// recomendada por falta de resposta, e o card dela não vai ao ar por cima dela. O resto do board segue — a espera é
// do card, nunca do board. Duas peças, de um lugar só:
//   1. `ownerPublishHold` — a trava: num card em só-negócio, nenhum AGENTE (a cascata, o advance-card das skills, o
//      move_card do MCP) o leva adiante rumo ao ar — da saída de «Aprovar entrega» até entrar em Publicar — enquanto
//      houver uma decisão do dono aberta nele (uma pergunta dele, ou o card tocar uma classe dele). O humano move
//      pela UI, sem trava: é ele quem decide. Voltar (refinar, corrigir), arquivar e chegar à aprovação seguem livres.
//      E, em QUALQUER modo, «Aprovar entrega» travada em CÓDIGO: com a caixa `delivery` do perfil desligada
//      (autonomy-profile.ts — Mínima, ou o modo humano de antes), nenhum agente atravessa o passo de aprovação rumo ao
//      ar. Antes isso era só texto da skill do condutor; agora é a régua que a cascata, o advance-card e o move_card leem.
//   2. `ownerDecisionsWaiting` — o que espera o dono (as entradas de Decidir do Inbox), com há quantos dias: o
//      lembrete semanal vai no resumo da semana (E), nunca num push por decisão. As propostas de PRD mantêm o vencimento de 14 dias
//      (governance.ts) — a única que sai do Inbox sozinha, e o board fica como estava.

import { isBusinessOnly, cardOwnerClass, whoDecides } from "./decision-class";
import { isDeployStep, type CockpitItem } from "./demands";
import type { InboxEntry } from "./inbox/entries";
import { formatDecisionText, localTimeFormatter, type TimeFormatter } from "./inbox/copy";
import { isDeliveryApprovalStep } from "./delivery-audit";
import { ownerClassLabel } from "./owner-classes";
import { storyDecides } from "./autonomy-profile";
import { openQuestions } from "./questions";
import type { BoardConfig, Card, StatusDef } from "./types";

/** O motivo de parada da cascata quando a trava segura o card (o prefixo; o resto diz qual decisão). */
export const OWNER_DECISION_STOP_REASON = "owner-decision";

const clip = (s: string, max = 90) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** As decisões do dono ABERTAS neste card, em português (vazio = nenhuma). Em só-negócio; fora dele, vazio. PURA. */
export function ownerDecisionsOnCard(
  card: Pick<Card, "autonomyMode" | "businessClasses" | "ownerReviewsUi" | "questions">,
  config: Pick<BoardConfig, "autonomy">,
  opts: { questionsOnly?: boolean } = {},
): string[] {
  if (!isBusinessOnly(card, config)) return [];
  const out: string[] = [];
  for (const q of openQuestions(card)) {
    if (whoDecides({ kind: "question", question: q }, card, config).decider === "owner") out.push(`a pergunta «${clip(q.text)}»`);
  }
  if (opts.questionsOnly) return out;
  const touched = cardOwnerClass(card);
  if (touched) out.push(`o card toca «${ownerClassLabel(touched, config)}»`);
  return out;
}

/**
 * Os passos RUMO AO AR que a trava guarda: depois do primeiro passo de aprovação de entrega até o passo de publicar,
 * inclusive (sem aprovação declarada, só o de publicar). Terminal e reentrada ficam de fora — arquivar e voltar não
 * publicam nada. PURA.
 */
function heldTargets(statuses: readonly StatusDef[]): Set<string> {
  const deployIdx = statuses.findIndex((s) => isDeployStep(s));
  if (deployIdx < 0) return new Set();
  const approvalIdx = statuses.findIndex((s) => isDeliveryApprovalStep(s));
  const from = approvalIdx >= 0 && approvalIdx < deployIdx ? approvalIdx + 1 : deployIdx;
  return new Set(statuses.slice(from, deployIdx + 1).filter((s) => !s.terminal).map((s) => s.id));
}

/**
 * O movimento ATRAVESSA o passo de aprovação de entrega — sai dele, ou o pula — para frente? Sem passo de aprovação
 * declarado, nunca. PURA.
 */
function crossesDeliveryApproval(from: Pick<StatusDef, "id"> | null | undefined, to: Pick<StatusDef, "id">, statuses: readonly StatusDef[]): boolean {
  const approvalIdx = statuses.findIndex((s) => isDeliveryApprovalStep(s));
  if (approvalIdx < 0) return false;
  const toIdx = statuses.findIndex((s) => s.id === to.id);
  const fromIdx = from ? statuses.findIndex((s) => s.id === from.id) : -1;
  return fromIdx >= 0 && fromIdx <= approvalIdx && toIdx > approvalIdx;
}

/**
 * Este movimento de um AGENTE leva o card rumo ao ar por cima de uma decisão do dono? O motivo, em português — ou
 * null (livre). Só em só-negócio (no modo humano o dono já aprova cada passo). PURA — a cascata (decideForward), o
 * advance-card (decideAdvance) e o move_card do MCP leem esta mesma régua.
 *
 * `ownerApproved` — o DONO já atravessou o passo de aprovar a entrega deste card (o ledger de transições diz quem
 * tirou o card de lá: delivery-audit.ts `isAutonomousDelivery`). A partir daí «o card toca uma classe do dono» deixa de
 * segurar: foi exatamente isso que ele aprovou. Sem isto, um card de dados de pessoas aprovado pelo dono ficava
 * parado em «Integrar» para sempre, sem item no Inbox. Uma PERGUNTA do dono ainda
 * aberta continua segurando em qualquer passo — ela é uma decisão que ele ainda não tomou.
 */
export function ownerPublishHold(
  card: Pick<Card, "autonomyMode" | "businessClasses" | "ownerReviewsUi" | "questions" | "status"> & Partial<Pick<Card, "deferred">>,
  from: Pick<StatusDef, "id"> | null | undefined,
  to: Pick<StatusDef, "id"> | null | undefined,
  config: Pick<BoardConfig, "autonomy" | "statuses">,
  opts: { ownerApproved?: boolean } = {},
): string | null {
  if (!to || !heldTargets(config.statuses).has(to.id)) return null;
  // voltar (ou ficar) não publica nada
  const idx = (id: string) => config.statuses.findIndex((s) => s.id === id);
  if (from && idx(to.id) <= idx(from.id)) return null;
  // Um card ADIADO (deferral.ts — inclusive o «Parar» do teto de rodadas) não vai ao ar pela mão de um agente, em
  // qualquer modo: adiar é «não agora», e levar adiante rumo ao ar é exatamente o que o adiamento suspende.
  if (card.deferred) return `o card está adiado (${card.deferred.reason}) — só o dono o leva adiante`;
  // «Aprovar entrega» TRAVADA EM CÓDIGO: atravessar o passo de aprovação (sair dele, ou pulá-lo) rumo ao ar, com a caixa
  // `delivery` desligada para esta story, é do dono — salvo quando foi ele quem já atravessou (`ownerApproved`).
  if (!opts.ownerApproved && crossesDeliveryApproval(from, to, config.statuses) && !storyDecides(card, config, "delivery")) {
    return "espera o dono em «Aprovar entrega»: a autonomia deste board deixa a aprovação da entrega com ele";
  }
  const decisions = ownerDecisionsOnCard(card, config, { questionsOnly: opts.ownerApproved === true });
  if (!decisions.length) return null;
  return `espera o dono antes de ir ao ar: ${decisions.join("; ")}`;
}

/** Uma decisão esperando o dono — a linha do lembrete semanal. */
export interface OwnerWaiting {
  boardId: string;
  cardId: string;
  cardTitle: string;
  kind: CockpitItem["kind"];
  /** o que decidir, em português simples. */
  what: string;
  /** o rótulo da classe do dono, quando há uma. */
  ownerClass: string | null;
  since: string | null;
  /** dias inteiros esperando (null sem data). */
  days: number | null;
}

/**
 * As decisões que ESPERAM o dono — as entradas de DECIDIR do Inbox (onda 2: o MESMO modelo do badge, da lista e do
 * push; antes esta projeção tinha a sua própria régua, e o lembrete de segunda podia contar diferente do Inbox). A
 * decisão entra como o dono a lê («Publicar «X» em produção?»), com a classe dele quando há uma. A mais antiga
 * primeiro, com os dias. PURA.
 */
export function ownerDecisionsWaiting(
  entries: readonly InboxEntry[],
  config: Pick<BoardConfig, "autonomy">,
  now: number,
  fmt: TimeFormatter = localTimeFormatter(now),
): OwnerWaiting[] {
  const out: OwnerWaiting[] = [];
  for (const e of entries) {
    if (e.decision.bucket !== "decidir" || e.kind === "system-decision") continue;
    const t = e.decision.since ? Date.parse(e.decision.since) : NaN;
    out.push({
      boardId: e.boardId,
      cardId: e.cardId,
      cardTitle: e.cardTitle,
      kind: e.kind,
      what: clip(formatDecisionText(e.decision.ask, fmt), 160),
      ownerClass: e.decision.verdict.ownerClass ? ownerClassLabel(e.decision.verdict.ownerClass, config) : null,
      since: e.decision.since ?? null,
      days: Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / 86_400_000)) : null,
    });
  }
  return out.sort((a, b) => (a.since ?? "9999").localeCompare(b.since ?? "9999"));
}
