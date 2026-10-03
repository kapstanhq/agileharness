// O CICLO EXTRA DE VERIFICAÇÃO de um card conduzido — a regra do operador, agora em código.
//
// O que o operador decidiu: depois de 2 ciclos de verificação reprovados, UM ciclo extra no máximo (3 no total), decidido
// por alguém que não é o condutor; depois dele, separa — o que sobra vira card de conserto, ou o dono decide. Até aqui
// a regra só existia em prosa (a skill do condutor mandava perguntar `technical` e «dizer quanto custa»), e a prosa
// acendia o piso de dinheiro: duas perguntas de protocolo («faço um ciclo extra?») foram ao
// dono como «Dinheiro e preço». Nada contava ciclos, então
// um 4º pedido seria respondido como qualquer outro.
//
// A RÉGUA (judgeExtraCycle), no molde do teto de gasto (card-budget.ts) — uma regra decide, não um modelo:
//   • o 1º pedido, depois do 2º ciclo reprovado e com a estimativa dentro do teto em vigor ⇒ aprovado PELA REGRA, com
//     registro em Acompanhar e «Desfazer» (reabre a pergunta para o dono);
//   • a estimativa passa do teto ⇒ encadeia o pedido de teto (request_budget): se a régua do teto aprovar, o ciclo sai
//     junto; senão o condutor estaciona e pede de novo quando o teto subir;
//   • o 2º pedido (ou depois do 3º ciclo) ⇒ uma pergunta do DONO (category owner), em palavras simples — o critério
//     que falha; aceitar o risco e integrar / mais um ciclo / parar — e o condutor estaciona;
//   • a REPETIÇÃO de um pedido já decidido (o mesmo ciclo pedido de novo) ⇒ o que foi decidido, com o mesmo id. O agente
//     repete a chamada depois de um erro de transporte do MCP; antes, a repetição da 1ª chamada
//     virava a pergunta do dono do «4º ciclo» e o ciclo aprovado se perdia, e a chamada concorrente dava `ok:false`.
//
// COMO FICA GUARDADO — como o teto: sem campo novo, o pedido É uma pergunta no card (`askedBy: "ciclo-extra:<n>"`),
// com o custo estimado em `costUsd` (dado, nunca prosa). A aprovação da regra é a pergunta respondida pelo sistema;
// o «Desfazer» a reabre (system-decisions.ts) e, a partir dali, ela é do dono. Um restart não perde nada.
// Núcleo puro + DI (requestExtraCycle); a produção mora em extra-cycle-deps.ts.

import type { SystemDecision } from "@/lib/storymap/system-decisions";
import type { Card, CardQuestion } from "@/lib/storymap/types";
import { effectiveCardBudgetUSD, type BudgetVerdict } from "./card-budget";
import { newSystemDecisionId } from "./decision-log";

/** O ciclo que a regra concede: o 3º (os 2 primeiros são do condutor). */
export const EXTRA_CYCLE = 3;
/** Quantos ciclos de verificação o condutor faz sozinho antes de pedir o extra. */
export const CONDUCTOR_LOOPS = 2;
/** Na pergunta registrada pela regra, a opção que a regra escolhe é a primeira. */
export const EXTRA_CYCLE_GO_OPTION = "o1";
/** Na pergunta do DONO (do 4º ciclo em diante), «mais uma rodada» é a segunda opção (ver extraCycleOwnerQuestion). */
const OWNER_GO_OPTION = "o2";

const ASKED_BY = /^ciclo-extra:(\d+)$/;

/** O que a régua do teto respondeu (card-budget.ts) — o pedido de ciclo extra que passa do teto encadeia nela. */
type BudgetKind = BudgetVerdict["kind"];

/** O marcador do pedido: qual ciclo foi pedido. */
export function extraCycleAskedBy(cycle: number): string {
  return `ciclo-extra:${cycle}`;
}

/** O ciclo pedido por uma pergunta de ciclo extra, ou null se não é uma. PURA. */
export function extraCycleNumber(q: Pick<CardQuestion, "askedBy">): number | null {
  const m = ASKED_BY.exec(q.askedBy ?? "");
  return m ? Number(m[1]) : null;
}

/** Os pedidos de ciclo extra do card (qualquer estado), em ordem. PURA. */
export function extraCycleRequests(card: Pick<Card, "questions">): Array<{ cycle: number; questionId: string; open: boolean }> {
  const out: Array<{ cycle: number; questionId: string; open: boolean }> = [];
  for (const q of card.questions ?? []) {
    const cycle = extraCycleNumber(q);
    if (cycle != null) out.push({ cycle, questionId: q.id, open: q.status === "open" });
  }
  return out;
}

export type ExtraCycleVerdict =
  /** o condutor ainda tem ciclo dele: o extra vem depois do 2º reprovado. */
  | { kind: "too-early"; why: string }
  /** já há um pedido aberto (do dono — o 2º, ou o 1º que o dono desfez): espere a resposta. */
  | { kind: "pending"; questionId: string; why: string }
  /** o 1º pedido, dentro do teto: a regra aprova. */
  | { kind: "approved"; why: string }
  /** o 1º pedido, mas passa do teto em vigor: encadeia o pedido de teto até `toUSD`. */
  | { kind: "budget"; toUSD: number; why: string }
  /** o 2º pedido (ou depois do 3º ciclo): é do dono. */
  | { kind: "owner"; cycle: number; why: string }
  /** este MESMO ciclo já foi pedido e decidido (pela regra, ou pelo dono): devolve a decisão, sem pedido novo. */
  | { kind: "replay"; questionId: string; approved: boolean; by: "rule" | "owner"; why: string };

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(".", ","));
const round2 = (n: number) => Math.round(n * 100) / 100;

/** O ciclo que uma chamada pede: o seguinte aos ciclos que o condutor diz ter usado — nunca antes do extra. PURA. */
function requestedCycle(loopsUsed: number): number {
  return Math.max(loopsUsed + 1, EXTRA_CYCLE);
}

/**
 * A decisão JÁ registrada para este ciclo, ou null. A pergunta do ciclo respondida diz quem decidiu (a regra =
 * respondida pelo sistema; senão o dono, depois do «Desfazer» ou na pergunta dele) e se o ciclo vai: a opção «fazer»
 * do registro da regra, ou «mais uma rodada» da pergunta do dono. PURA.
 */
function decidedRequest(card: Pick<Card, "questions">, cycle: number): Extract<ExtraCycleVerdict, { kind: "replay" }> | null {
  const q = (card.questions ?? []).find((x) => extraCycleNumber(x) === cycle && x.status === "answered");
  if (!q) return null;
  const go = cycle === EXTRA_CYCLE ? EXTRA_CYCLE_GO_OPTION : OWNER_GO_OPTION;
  const approved = (q.selectedOptionIds ?? []).includes(go);
  const by = q.answeredBy === "system" ? "rule" : "owner";
  return {
    kind: "replay",
    questionId: q.id,
    approved,
    by,
    why:
      `o ${cycle}º ciclo já foi decidido ${by === "rule" ? "pela regra" : "pelo dono"} (${q.id}): ` +
      (approved ? "pode fazer o ciclo" : `não fazer o ciclo${q.answer ? ` — «${q.answer.trim().slice(0, 200)}»` : ""}`),
  };
}

/** A régua inteira do pedido de ciclo extra. `capUSD` = o teto do settings (o em vigor sai do card). PURA. */
export function judgeExtraCycle(input: {
  card: Pick<Card, "questions">;
  loopsUsed: number;
  estimateUSD: number;
  capUSD: number | null;
  spentUSD: number;
}): ExtraCycleVerdict {
  const { card, loopsUsed, estimateUSD, spentUSD } = input;
  const prior = extraCycleRequests(card);
  const open = prior.find((r) => r.open);
  if (open) return { kind: "pending", questionId: open.questionId, why: "já há um pedido de ciclo extra aberto neste card — espere a resposta dele" };
  if (loopsUsed < CONDUCTOR_LOOPS) {
    return { kind: "too-early", why: `o ciclo extra vem depois do ${CONDUCTOR_LOOPS}º ciclo de verificação reprovado (você usou ${loopsUsed})` };
  }
  const replay = decidedRequest(card, requestedCycle(loopsUsed));
  if (replay) return replay;
  if (prior.length > 0 || loopsUsed > CONDUCTOR_LOOPS) {
    const cycle = Math.max(loopsUsed + 1, EXTRA_CYCLE + 1, ...prior.map((r) => r.cycle + 1));
    return { kind: "owner", cycle, why: `o card já usou o ciclo extra que a regra concede (${EXTRA_CYCLE} no total) — o ${cycle}º é decisão do dono` };
  }
  const inForce = effectiveCardBudgetUSD(input.capUSD, card);
  const projected = round2(spentUSD + Math.max(0, estimateUSD));
  if (inForce != null && projected > inForce) {
    return { kind: "budget", toUSD: projected, why: `o ciclo (~US$ ${fmt(round2(estimateUSD))}) leva o card a US$ ${fmt(projected)}, acima do teto de US$ ${fmt(inForce)}` };
  }
  return {
    kind: "approved",
    why:
      `é o 1º pedido depois de ${CONDUCTOR_LOOPS} ciclos reprovados e cabe no teto` +
      (inForce != null ? ` (US$ ${fmt(projected)} de US$ ${fmt(inForce)})` : " (este alvo não declara teto por card)"),
  };
}

/** Os critérios que falham, em palavras simples (curtos, no máximo 3). PURA. */
function failingText(failing: readonly string[]): string {
  const items = failing.map((f) => f.trim().replace(/\s+/g, " ").slice(0, 160)).filter(Boolean);
  const shown = items.slice(0, 3).map((f) => `«${f}»`).join(", ");
  return items.length > 3 ? `${shown} e mais ${items.length - 3}` : shown;
}

/** O registro do ciclo concedido PELA REGRA: a pergunta já respondida pelo sistema, com o custo como dado. PURA. */
export function extraCycleRecord(input: { id: string; failing: readonly string[]; reason: string; estimateUSD: number; why: string; today: string }): CardQuestion {
  const { id, failing, reason, estimateUSD, why, today } = input;
  return {
    id,
    text: `Fazer o ciclo extra de verificação (o ${EXTRA_CYCLE}º e último) neste card?`,
    askedBy: extraCycleAskedBy(EXTRA_CYCLE),
    askedAt: today,
    status: "answered",
    answer: `Aprovado pela regra do ciclo extra: ${why}.`,
    answeredAt: today,
    answeredBy: "system",
    selectedOptionIds: [EXTRA_CYCLE_GO_OPTION],
    category: "technical",
    costUsd: round2(estimateUSD),
    mode: "single",
    context: `Ainda falha: ${failingText(failing)}. O condutor diz: ${reason.trim().replace(/\s+/g, " ").slice(0, 400)}`,
    options: [
      { id: EXTRA_CYCLE_GO_OPTION, label: "Fazer o ciclo extra (o último)" },
      { id: "o2", label: "Integrar agora; o que falta vira um card de conserto" },
      { id: "o3", label: "Parar o card aqui" },
    ],
  };
}

/**
 * A pergunta do DONO no 2º pedido — em palavras simples, sem jargão. A decisão é dele pela regra que ele fez. As
 * rodadas são as que o condutor diz ter feito (`rounds` = loopsUsed), não o número do ciclo pedido. PURA.
 */
export function extraCycleOwnerQuestion(input: {
  id: string;
  cycle: number;
  rounds: number;
  failing: readonly string[];
  reason: string;
  estimateUSD: number;
  today: string;
}): CardQuestion {
  const { id, cycle, rounds, failing, reason, estimateUSD, today } = input;
  return {
    id,
    text: `Depois de ${rounds} rodadas de verificação, ainda falha: ${failingText(failing)}. O que fazemos?`,
    askedBy: extraCycleAskedBy(cycle),
    askedAt: today,
    status: "open",
    category: "owner",
    costUsd: round2(estimateUSD),
    mode: "single",
    context:
      `Pela regra do ciclo extra, o sistema autoriza UMA rodada extra e depois separa; este card já a usou. ` +
      `O que o agente diz: ${reason.trim().replace(/\s+/g, " ").slice(0, 400)}`,
    options: [
      { id: "o1", label: "Aceitar como está e publicar; o que falta vira outro card", pros: ["a entrega sai agora"], cons: ["o que falha vai junto até o conserto"] },
      { id: "o2", label: "Autorizar mais uma rodada de correção", pros: ["pode fechar o que falta"], cons: [`cerca de US$ ${fmt(round2(estimateUSD))} a mais, sem garantia`] },
      { id: "o3", label: "Parar o card aqui", pros: ["nada a mais é gasto"], cons: ["o trabalho fica guardado, sem ir ao ar"] },
    ],
  };
}

/** O registro em Acompanhar — desfazer é reabrir a pergunta (o ciclo passa a ser decisão do dono). PURO. */
export function extraCycleDecision(input: { board: string; card: Pick<Card, "id" | "title">; questionId: string; why: string; at: string }): SystemDecision {
  return {
    v: 1,
    id: newSystemDecisionId(),
    at: input.at,
    board: input.board,
    cardId: input.card.id,
    agent: "system",
    kind: "extra-cycle",
    what: `Autorizou o ciclo extra de verificação de «${input.card.title}» (o ${EXTRA_CYCLE}º e último)`,
    why: input.why,
    undo: { kind: "reopen-question", cardId: input.card.id, questionId: input.questionId },
  };
}

// ── o pedido inteiro, com as portas injetadas ────────────────────────────────────────────────────────────────────────

export interface ExtraCycleInput {
  board: string;
  cardId: string;
  /** quantos ciclos de verificação reprovados o condutor já fez (o diário dele). */
  loopsUsed: number;
  /** os critérios que ainda falham, em palavras simples. */
  failing: string[];
  /** o que o ciclo conserta, em uma ou duas frases. */
  reason: string;
  /** quanto o ciclo deve custar, em dólares (gasto de IA do card). */
  estimateUSD: number;
}

export interface ExtraCycleDeps {
  readCard(board: string, cardId: string): Promise<Card | null>;
  /** o teto do settings e o gasto do card agora (ledger + sessões vivas). */
  spend(board: string, cardId: string): Promise<{ capUSD: number | null; spentUSD: number }>;
  /** o pedido de teto (card-budget-deps.ts requestBudgetNow). */
  requestBudget(input: { board: string; cardId: string; toUSD: number; reason: string }): Promise<
    { ok: false; error: string } | { ok: true; verdict: BudgetKind; approved: boolean; questionId?: string; detail?: string }
  >;
  /** grava sob a trava do card: o updater recebe o card FRESCO; null = não grava. true = gravou. */
  update(board: string, cardId: string, fn: (fresh: Card) => Card | null): Promise<boolean>;
  nextQuestionId(questions: readonly CardQuestion[]): string;
  record(entry: SystemDecision): Promise<void>;
  today(): string;
  now(): number;
}

export type ExtraCycleResult =
  | { ok: false; error: string }
  | {
      ok: true;
      verdict: "approved" | "budget" | "owner" | "pending";
      /** true = faça o ciclo agora. */
      approved: boolean;
      questionId?: string;
      /** quando encadeou o teto: o que a régua do teto disse. */
      budget?: { verdict: BudgetKind; questionId?: string; detail?: string };
      detail: string;
    };

/** O resultado de um pedido que NÃO grava nada: o aberto que espera resposta, ou o mesmo ciclo já decidido. PURA. */
function settledResult(v: Extract<ExtraCycleVerdict, { kind: "pending" | "replay" }>): ExtraCycleResult {
  if (v.kind === "pending") return { ok: true, verdict: "pending", approved: false, questionId: v.questionId, detail: v.why };
  return { ok: true, verdict: v.by === "rule" ? "approved" : "owner", approved: v.approved, questionId: v.questionId, detail: v.why };
}

/** O pedido de ciclo extra (a tool `request_extra_cycle`). Nunca lança: erro de IO vira `{ ok: false }`. */
export async function requestExtraCycle(input: ExtraCycleInput, deps: ExtraCycleDeps): Promise<ExtraCycleResult> {
  const { board, cardId } = input;
  if (!Number.isInteger(input.loopsUsed) || input.loopsUsed < 0) return { ok: false, error: "loopsUsed precisa ser um inteiro ≥ 0 (os ciclos de verificação reprovados)" };
  if (!Number.isFinite(input.estimateUSD) || input.estimateUSD < 0) return { ok: false, error: "estimateUSD precisa ser um valor em dólares ≥ 0" };
  const failing = (input.failing ?? []).map((f) => f.trim()).filter(Boolean);
  if (!failing.length) return { ok: false, error: "diga qual critério ainda falha (failing)" };
  if (!input.reason?.trim()) return { ok: false, error: "diga o que o ciclo conserta (reason)" };
  try {
    const card = await deps.readCard(board, cardId);
    if (!card) return { ok: false, error: `card não encontrado: ${cardId}` };
    const { capUSD, spentUSD } = await deps.spend(board, cardId);
    const judge = (c: Card) => judgeExtraCycle({ card: c, loopsUsed: input.loopsUsed, estimateUSD: input.estimateUSD, capUSD, spentUSD });
    let verdict = judge(card);
    if (verdict.kind === "too-early") return { ok: false, error: verdict.why };
    if (verdict.kind === "pending" || verdict.kind === "replay") return settledResult(verdict);

    let budget: { verdict: BudgetKind; questionId?: string; detail?: string } | undefined;
    if (verdict.kind === "budget") {
      const r = await deps.requestBudget({ board, cardId, toUSD: verdict.toUSD, reason: `ciclo extra de verificação — ${input.reason.trim()}` });
      if (!r.ok) return { ok: false, error: `o ciclo extra passa do teto e o pedido de teto falhou: ${r.error}` };
      budget = { verdict: r.verdict, ...(r.questionId ? { questionId: r.questionId } : {}), ...(r.detail ? { detail: r.detail } : {}) };
      if (!r.approved) {
        return {
          ok: true,
          verdict: "budget",
          approved: false,
          budget,
          detail: `${verdict.why}: o pedido de teto foi aberto (${r.verdict}). Estacione; quando o teto subir, peça o ciclo extra de novo.`,
        };
      }
      verdict = { kind: "approved", why: `${verdict.why}, e o teto subiu pela regra do teto` };
    }

    let decided: Extract<ExtraCycleVerdict, { kind: "approved" | "owner" }> = verdict; // aqui só sobra «approved» ou «owner»
    const today = deps.today();
    let questionId = "";
    let raced: Extract<ExtraCycleVerdict, { kind: "pending" | "replay" }> | null = null;
    const written = await deps.update(board, cardId, (fresh) => {
      // a régua de novo sobre o card FRESCO: outra chamada (muitas vezes a MESMA, repetida) pode ter gravado um pedido
      // entre a leitura e a trava. Aberto ou o mesmo ciclo já decidido ⇒ devolve aquilo; um ciclo extra concedido por
      // outra chamada ⇒ este pedido já é o do dono. (O teto encadeado não é refeito aqui: ele já subiu ou não.)
      const again = judge(fresh);
      if (again.kind === "pending" || again.kind === "replay") {
        raced = again;
        return null;
      }
      if (decided.kind === "approved" && again.kind === "owner") decided = again;
      questionId = deps.nextQuestionId(fresh.questions ?? []);
      const q =
        decided.kind === "approved"
          ? extraCycleRecord({ id: questionId, failing, reason: input.reason, estimateUSD: input.estimateUSD, why: decided.why, today })
          : extraCycleOwnerQuestion({ id: questionId, cycle: decided.cycle, rounds: input.loopsUsed, failing, reason: input.reason, estimateUSD: input.estimateUSD, today });
      return { ...fresh, questions: [...(fresh.questions ?? []), q] };
    });
    if (raced) return settledResult(raced);
    if (!written || !questionId) return { ok: false, error: "não foi possível registrar o pedido no card (tente de novo)" };
    if (decided.kind === "approved") {
      await deps.record(extraCycleDecision({ board, card, questionId, why: decided.why, at: new Date(deps.now()).toISOString() })).catch(() => {});
      return { ok: true, verdict: "approved", approved: true, questionId, ...(budget ? { budget } : {}), detail: decided.why };
    }
    return { ok: true, verdict: "owner", approved: false, questionId, detail: `${decided.why}. A pergunta está no Inbox do dono: estacione.` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
