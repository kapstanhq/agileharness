// O TETO DE GASTO DE IA DE UM CARD e o seu aumento — fatia 3 das «paradas por recurso».
//
// A regra: quando falta orçamento no card, o sistema aprova sozinho um aumento de ATÉ +30% do teto, UMA
// vez por card, e só com a cota do Claude NO RITMO (consumo da semana ≤ tempo já decorrido da semana; janela de 5
// horas abaixo de 70%). Cota fora do ritmo ⇒ o pedido espera e é aprovado quando o ritmo voltar (o dono pode liberar
// antes). Acima de +30%, ou um segundo aumento ⇒ é do dono. A exceção à regra «dinheiro, só o dono» vale só para
// gasto de IA do card — fornecedor, plano, API paga, preço e custo mensal do produto não passam por aqui.
//
// COMO FICA GUARDADO — sem campo novo, sem ledger paralelo: o pedido de aumento É uma pergunta de dinheiro no card
// (`askedBy: "teto:<valor>"`, primeira opção = aprovar). O teto em vigor do card é DERIVADO dela: o maior valor entre
// o teto do settings e os pedidos respondidos com «aprovar». Consequências que vêm de graça:
//   • o dono vê o pedido no Inbox com botões, e a resposta dele vale na hora (não há segundo passo);
//   • o condutor que espera o dono estaciona e é retomado pelo mesmo caminho de qualquer pergunta (conductor-pause);
//   • «desfazer» a aprovação do sistema é reabrir a pergunta — o aumento some com ela;
//   • um restart não perde nada: está no card.
// Quem aprova dentro do envelope é uma REGRA (esta), não um modelo: o que protege o dono é o envelope e o ritmo da
// cota, e uma regra não erra a conta nem custa cota para decidir. Núcleo puro + DI; a produção mora em
// card-budget-deps.ts.

import type { SystemDecision } from "@/lib/storymap/system-decisions";
import type { Card, CardQuestion } from "@/lib/storymap/types";
import { newSystemDecisionId } from "./decision-log";

/** `autorun.budgetRaise` do settings. */
export interface BudgetRaiseSettings {
  /** quanto acima do teto o sistema aprova sozinho, em % (30 ⇒ até 1,3 × o teto). 0 = nunca sozinho. */
  maxPct: number;
  /** a janela de 5 horas tem de estar ABAIXO disto (%) para a cota contar como «no ritmo». */
  fiveHourMaxPct: number;
}
export const DEFAULT_BUDGET_RAISE: BudgetRaiseSettings = { maxPct: 30, fiveHourMaxPct: 70 };

const WEEK_MS = 7 * 24 * 60 * 60_000;
const ASKED_BY = /^teto:(\d+(?:\.\d{1,2})?)$/;
/** A opção que aprova o aumento é SEMPRE a primeira. */
export const BUDGET_APPROVE_OPTION = "o1";

/** O marcador do pedido: quem perguntou diz QUANTO pediu. */
export function budgetAskedBy(toUSD: number): string {
  return `teto:${Math.round(toUSD * 100) / 100}`;
}

/** O valor pedido por uma pergunta de teto, ou null se não é uma. PURA. */
export function budgetRequestUSD(q: Pick<CardQuestion, "askedBy">): number | null {
  const m = ASKED_BY.exec(q.askedBy ?? "");
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

const approved = (q: CardQuestion) => q.status === "answered" && (q.selectedOptionIds ?? []).includes(BUDGET_APPROVE_OPTION);

/** Os aumentos APROVADOS do card (por quem for), do maior para o menor. PURA. */
export function approvedRaises(card: Pick<Card, "questions">): Array<{ toUSD: number; by: string; questionId: string }> {
  const out: Array<{ toUSD: number; by: string; questionId: string }> = [];
  for (const q of card.questions ?? []) {
    const toUSD = budgetRequestUSD(q);
    if (toUSD != null && approved(q)) out.push({ toUSD, by: q.answeredBy ?? "human", questionId: q.id });
  }
  return out.sort((a, b) => b.toUSD - a.toUSD);
}

/**
 * Os pedidos de aumento ainda ABERTOS do card. `ownerOnly` = o dono DESFEZ uma aprovação do sistema nesta pergunta
 * (o carimbo `reopened` do desfazer, system-decisions.ts): daí em diante ela é dele, e a regra não a aprova de novo.
 * PURA.
 */
export function openBudgetRequests(card: Pick<Card, "questions">): Array<{ toUSD: number; questionId: string; ownerOnly: boolean }> {
  const out: Array<{ toUSD: number; questionId: string; ownerOnly: boolean }> = [];
  for (const q of card.questions ?? []) {
    const toUSD = budgetRequestUSD(q);
    if (toUSD != null && q.status === "open") out.push({ toUSD, questionId: q.id, ownerOnly: q.proxy?.auditOutcome === "reopened" });
  }
  return out;
}

/** O teto EM VIGOR do card: o do settings, ou um aumento aprovado maior que ele. `null` = sem teto. PURA. */
export function effectiveCardBudgetUSD(cap: number | null | undefined, card: Pick<Card, "questions">): number | null {
  if (typeof cap !== "number" || !(cap > 0)) return null;
  return Math.max(cap, approvedRaises(card)[0]?.toUSD ?? 0);
}

/** A leitura da cota que a régua do ritmo usa (o medidor do governador de capacidade). */
export interface QuotaReading {
  usage7dPct: number;
  usage5hPct: number | null;
  resetsAt7d: number;
  /** a leitura está velha demais para decidir por ela. */
  stale: boolean;
}

export interface QuotaPace {
  onPace: boolean;
  /** em linguagem de dono — vai para o card e para o registro. */
  detail: string;
}

/**
 * «No ritmo da semana»: o consumo da semana é igual ou menor que o tempo já decorrido dela, e a
 * janela de 5 horas está abaixo do limite. Sem leitura, ou com leitura velha, NÃO está no ritmo (fail-closed: sem
 * saber quanto resta, o sistema não gasta mais sozinho). PURA.
 */
export function quotaPace(reading: QuotaReading | null, now: number, s: BudgetRaiseSettings): QuotaPace {
  if (!reading) return { onPace: false, detail: "não há leitura da cota do Claude" };
  if (reading.stale) return { onPace: false, detail: "a leitura da cota do Claude está desatualizada" };
  const elapsedPct = Math.min(100, Math.max(0, ((now - (reading.resetsAt7d - WEEK_MS)) / WEEK_MS) * 100));
  const used = Math.round(reading.usage7dPct);
  const elapsed = Math.round(elapsedPct);
  if (reading.usage7dPct > elapsedPct) return { onPace: false, detail: `a semana já consumiu ${used}% da cota com ${elapsed}% do tempo decorrido` };
  if (reading.usage5hPct != null && reading.usage5hPct >= s.fiveHourMaxPct) {
    return { onPace: false, detail: `a janela de 5 horas está em ${Math.round(reading.usage5hPct)}% (o limite para aprovar sozinho é ${s.fiveHourMaxPct}%)` };
  }
  return { onPace: true, detail: `a semana consumiu ${used}% da cota com ${elapsed}% do tempo decorrido` };
}

export type BudgetVerdict =
  | { kind: "no-cap" }
  /** o que foi pedido já cabe no teto em vigor. */
  | { kind: "not-needed"; capUSD: number }
  /** dentro do envelope, primeiro aumento e cota no ritmo: o sistema aprova. */
  | { kind: "approved"; toUSD: number; why: string }
  /** dentro do envelope e primeiro aumento, mas a cota está fora do ritmo: espera (e o dono pode liberar antes). */
  | { kind: "wait-quota"; toUSD: number; why: string }
  /** acima do envelope, ou já houve um aumento: é do dono. */
  | { kind: "owner"; toUSD: number; why: string };

/** A régua inteira do pedido de aumento. PURA. */
export function judgeBudgetRequest(input: { capUSD: number | null | undefined; card: Pick<Card, "questions">; toUSD: number; pace: QuotaPace; settings: BudgetRaiseSettings }): BudgetVerdict {
  const { capUSD, card, toUSD, pace, settings } = input;
  if (typeof capUSD !== "number" || !(capUSD > 0)) return { kind: "no-cap" };
  const inForce = effectiveCardBudgetUSD(capUSD, card) as number;
  if (!(toUSD > inForce)) return { kind: "not-needed", capUSD: inForce };
  if (approvedRaises(card).length > 0) return { kind: "owner", toUSD, why: "este card já teve um aumento de teto — o segundo é decisão sua" };
  const ceiling = Math.round(capUSD * (1 + settings.maxPct / 100) * 100) / 100;
  if (!(settings.maxPct > 0) || toUSD > ceiling) {
    return { kind: "owner", toUSD, why: `o pedido (US$ ${fmt(toUSD)}) passa do que o sistema aprova sozinho (até US$ ${fmt(ceiling)}, ${settings.maxPct}% acima do teto de US$ ${fmt(capUSD)})` };
  }
  if (!pace.onPace) return { kind: "wait-quota", toUSD, why: pace.detail };
  return { kind: "approved", toUSD, why: `cabe no que o sistema aprova sozinho (até US$ ${fmt(ceiling)}) e ${pace.detail}` };
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(".", ","));

/** A pergunta do pedido, em linguagem de dono. A primeira opção SEMPRE aprova. PURA. */
export function budgetQuestion(input: { id: string; toUSD: number; capUSD: number; spentUSD: number; reason: string; verdict: Extract<BudgetVerdict, { kind: "wait-quota" | "owner" | "approved" }>; today: string }): CardQuestion {
  const { id, toUSD, capUSD, spentUSD, reason, verdict, today } = input;
  const context =
    `[humano] Gasto de IA do card (classe dinheiro). O card usou US$ ${fmt(spentUSD)} de um teto de US$ ${fmt(capUSD)}. ` +
    `O condutor pede: ${reason.trim().replace(/\s+/g, " ").slice(0, 400)} ` +
    (verdict.kind === "wait-quota"
      ? `O pedido cabe no que o sistema aprova sozinho, mas ${verdict.why}: ele será aprovado automaticamente quando a cota voltar ao ritmo. Você pode liberar antes.`
      : verdict.kind === "owner"
        ? `A decisão é sua porque ${verdict.why}.`
        : `Aprovado pelo sistema: ${verdict.why}.`);
  return {
    id,
    text: `Subir o teto de gasto deste card de US$ ${fmt(capUSD)} para US$ ${fmt(toUSD)}?`,
    askedBy: budgetAskedBy(toUSD),
    askedAt: today,
    status: "open",
    category: "money",
    ownerClass: "money",
    mode: "single",
    context,
    options: [
      { id: BUDGET_APPROVE_OPTION, label: `Subir o teto para US$ ${fmt(toUSD)}`, pros: ["o card termina o que falta"], cons: [`até US$ ${fmt(toUSD - capUSD)} a mais de gasto de IA`] },
      { id: "o2", label: `Manter US$ ${fmt(capUSD)} e seguir só com o que couber`, pros: ["nenhum gasto a mais"], cons: ["o que não couber fica de fora ou vira outro card"] },
      { id: "o3", label: "Parar o card aqui", pros: ["nenhum gasto a mais"], cons: ["o trabalho feito fica guardado, sem ir ao ar"] },
    ],
  };
}

/** A pergunta respondida pelo sistema (aprovada pela regra). PURA. */
export function approveAsSystem(q: CardQuestion, why: string, today: string): CardQuestion {
  return { ...q, status: "answered", answer: `Aprovado pelo sistema: ${why}.`, answeredAt: today, answeredBy: "system", selectedOptionIds: [BUDGET_APPROVE_OPTION] };
}

/** O registro da aprovação — desfazer é reabrir a pergunta (o aumento some com ela). PURO. */
export function budgetRaiseDecision(input: { board: string; card: Pick<Card, "id" | "title">; questionId: string; capUSD: number; toUSD: number; why: string; at: string }): SystemDecision {
  return {
    v: 1,
    id: newSystemDecisionId(),
    at: input.at,
    board: input.board,
    cardId: input.card.id,
    agent: "system",
    kind: "budget-raise",
    what: `Subiu o teto de gasto de «${input.card.title}» de US$ ${fmt(input.capUSD)} para US$ ${fmt(input.toUSD)}`,
    why: input.why,
    undo: { kind: "reopen-question", cardId: input.card.id, questionId: input.questionId },
  };
}

// ── a varredura: aprovar o que esperava a cota, e avisar o condutor que passou do teto ───────────────────────────

export interface BudgetSweepCard {
  board: string;
  card: Card;
  /** o gasto do card: ledger + a estimativa das sessões vivas. */
  spentUSD: number;
  /** a sessão do condutor vivo do card, se houver (para o aviso de teto). */
  liveConductor: { sessionId: string; tmuxSession: string } | null;
}

export interface CardBudgetSweepDeps {
  masterEnabled(): boolean;
  capUSD(): number | null;
  settings(): BudgetRaiseSettings;
  quota(): QuotaReading | null;
  /** os cards não terminais que têm pedido de teto aberto OU condutor vivo. */
  cards(): Promise<BudgetSweepCard[]>;
  /** responde a pergunta como o sistema (sob a trava do card). true = gravou. */
  approve(board: string, cardId: string, questionId: string, why: string): Promise<boolean>;
  /** acorda o condutor (vivo ou estacionado) depois de uma aprovação. */
  wake(board: string, cardId: string, questionId: string): Promise<void>;
  /** digita a linha fixa do teto no terminal do condutor. true = entregue. */
  warn(tmux: string, line: string): Promise<boolean>;
  record(entry: SystemDecision): Promise<void>;
  /** memória do aviso de teto (sessionId → teto avisado): uma vez por sessão e por teto. */
  warned: Map<string, number>;
  now?(): number;
  log?(line: string): void;
}

/** A linha fixa que o condutor recebe ao cruzar o teto — PURA (só números entram). */
export function capLine(spentUSD: number, capUSD: number): string {
  return (
    `teto — o gasto deste card chegou a US$ ${fmt(Math.round(spentUSD * 100) / 100)} do teto de US$ ${fmt(capUSD)}. ` +
    `Pare no próximo limite de bloco e peça o aumento com request_budget({board, cardId, toUSD, reason}), dizendo o que falta e quanto custa. ` +
    `Sem aumento aprovado, não comece outro bloco: siga a seção «Estacionar e retomar» da skill.`
  );
}

export interface CardBudgetSweepReport {
  approved: Array<{ board: string; cardId: string; toUSD: number }>;
  warned: Array<{ board: string; cardId: string }>;
}

/** Um passe. Nunca lança. */
export async function sweepCardBudgets(deps: CardBudgetSweepDeps): Promise<CardBudgetSweepReport> {
  const log = deps.log ?? ((l: string) => console.log(`[card-budget] ${l}`));
  const report: CardBudgetSweepReport = { approved: [], warned: [] };
  try {
    if (!deps.masterEnabled()) return report;
    const capUSD = deps.capUSD();
    if (capUSD == null) return report;
    const now = (deps.now ?? Date.now)();
    const settings = deps.settings();
    const pace = quotaPace(deps.quota(), now, settings);
    const alive = new Set<string>();
    for (const row of await deps.cards()) {
      const { board, card } = row;
      // 1 — o pedido que esperava a cota: a mesma régua de quando ele foi feito, com a cota de agora.
      for (const req of openBudgetRequests(card)) {
        if (req.ownerOnly) continue; // o dono desfez a aprovação do sistema: agora é dele
        const verdict = judgeBudgetRequest({ capUSD, card, toUSD: req.toUSD, pace, settings });
        if (verdict.kind !== "approved") continue;
        if (!(await deps.approve(board, card.id, req.questionId, verdict.why).catch(() => false))) continue;
        await deps.record(budgetRaiseDecision({ board, card, questionId: req.questionId, capUSD, toUSD: req.toUSD, why: verdict.why, at: new Date(now).toISOString() })).catch(() => {});
        await deps.wake(board, card.id, req.questionId).catch(() => {});
        report.approved.push({ board, cardId: card.id, toUSD: req.toUSD });
        log(`${board}/${card.id}: teto US$ ${fmt(capUSD)} → US$ ${fmt(req.toUSD)} aprovado pelo sistema (${verdict.why})`);
        break; // um aumento por card: os outros pedidos abertos passam a ser do dono
      }
      // 2 — o condutor vivo que passou do teto sem ter pedido nada: avisa uma vez.
      const session = row.liveConductor;
      if (!session) continue;
      alive.add(session.sessionId);
      const inForce = effectiveCardBudgetUSD(capUSD, card) as number;
      if (row.spentUSD < inForce || openBudgetRequests(card).length > 0) continue;
      if (deps.warned.get(session.sessionId) === inForce) continue;
      if (!(await deps.warn(session.tmuxSession, capLine(row.spentUSD, inForce)).catch(() => false))) continue;
      deps.warned.set(session.sessionId, inForce);
      report.warned.push({ board, cardId: card.id });
      log(`${board}/${card.id}: gasto US$ ${fmt(Math.round(row.spentUSD * 100) / 100)} ≥ teto US$ ${fmt(inForce)} — condutor avisado (${session.tmuxSession})`);
    }
    for (const id of deps.warned.keys()) if (!alive.has(id)) deps.warned.delete(id);
  } catch (err) {
    log(`a varredura falhou — ${err instanceof Error ? err.message : String(err)}`);
  }
  return report;
}
