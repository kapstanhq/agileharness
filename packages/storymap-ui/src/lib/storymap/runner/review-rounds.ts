// O TETO DE RODADAS DE REVISÃO — decisão do dono: depois de N rodadas da MESMA cadeia de conserto, o sistema para de
// abrir card novo e pergunta. PURO (zero IO): quem lê os cards e grava a pergunta é o chamador.
//
// POR QUE EXISTE. Uma revisão independente acha problema; o conserto nasce como card próprio; a revisão do conserto acha
// mais um; e assim por diante. Cada rodada custa uma sessão inteira de agente, e uma checagem por leitura de código pode
// nunca fechar em 100% — a cadeia não tem fim natural. O dono decidiu o teto (`autorun.reviewRoundsCap`, padrão 2): o
// card revisado e UM conserto o sistema faz sozinho; a terceira rodada vira pergunta — aceitar o risco restante e seguir,
// pagar mais uma rodada, ou parar.
//
// A CADEIA É UMA ÁRVORE MARCADA PELO SERVIDOR. Todo conserto de revisão nasce com `reviewChain: {root, round}` — gravado
// na MESMA escrita que o cria, por código do serviço (o `update_card` do agente recusa o campo; o drawer o preserva). A
// conta é a raiz mais TODOS os cards marcados com ela, em QUALQUER board: um conserto roteado para outro board, um card
// que mudou de board, consertos irmãos abertos do mesmo card — todos contam. (Antes a conta seguia um vínculo
// `relates-to`, que cai no roteamento e na mudança de board, e consertos irmãos não somavam.) Cards anteriores à marca
// — rótulo de rodada + `relates-to` para um membro do MESMO board — entram pela régua antiga, para a cadeia em curso não
// recomeçar do zero.
//
// A RESPOSTA DO DONO vale para a árvore inteira e é lida do REGISTRO DO SERVIDOR (review-rounds-ledger.ts), nunca do
// frontmatter (que um agente edita no worktree): «Pagar» vale UMA rodada; «Aceitar» e «Parar» valem para o CICLO em que
// foram dadas — o intervalo de commits e o modo da raiz — e um achado bloqueante pergunta de novo mesmo assim. «Parar»
// também adia os membros vivos da árvore (answerQuestionAction).

import { FINDING_FIX_LABEL } from "../finding-fix";
import { isReviewFinding } from "../review-finding";
import type { StructuredQuestionInput } from "../questions";
import type { Card, CardQuestion, ReviewChainMark } from "../types";

/** O rótulo do conserto aberto por um agente para os achados restantes de uma revisão (MCP `create_card` com `continuesFrom`). */
export const REVIEW_ROUND_LABEL = "rodada-de-revisao";
/** O rótulo do conserto aberto pela auditoria técnica independente (technical-audit-deps.ts). */
export const TECHNICAL_AUDIT_LABEL = "auditoria-tecnica";
/** A rodada que o dono PAGOU além do teto — conta como uma concessão usada. */
export const EXTRA_ROUND_LABEL = "rodada-extra";

/** Os rótulos que fazem de um card uma rodada da cadeia de conserto de uma revisão (régua antiga, sem a marca). */
export const REVIEW_ROUND_LABELS: ReadonlySet<string> = new Set([REVIEW_ROUND_LABEL, TECHNICAL_AUDIT_LABEL, FINDING_FIX_LABEL]);

/** O padrão do teto (o dono: 2). */
export const DEFAULT_REVIEW_ROUNDS_CAP = 2;

/** O começo fixo do texto da pergunta do teto — é por ele que a pergunta é reconhecida (e não repetida). */
export const ROUNDS_CAP_QUESTION_PREFIX = "Teto de rodadas de revisão:";
/** As opções, nesta ordem (os ids saem o1…o3 — questions.ts). */
export const ROUNDS_CAP_OPTIONS = ["Aceitar o risco restante e seguir", "Pagar mais uma rodada", "Parar"] as const;
export const ACCEPT_OPTION_ID = "o1";
export const EXTRA_ROUND_OPTION_ID = "o2";
export const STOP_OPTION_ID = "o3";

/** Um card de qualquer board, com o board dele. */
export interface BoardCard {
  board: string;
  card: Pick<Card, "id" | "labels" | "links" | "questions" | "reviewChain"> & Partial<Pick<Card, "commitRange" | "mode">>;
}

/** Uma resposta do dono ao teto, como o SERVIDOR a registrou (review-rounds-ledger.ts). */
export interface RoundAnswer {
  /** a raiz da árvore (`<board>/<cardId>`). */
  root: string;
  choice: "accept" | "extra" | "stop";
  /** ISO. */
  at: string;
  /** o ciclo da raiz quando foi respondida ({@link cycleOf}). */
  cycle: string;
  board: string;
  cardId: string;
  questionId: string;
}

/** A escolha de uma resposta à pergunta do teto, pelas opções marcadas (null = não é uma das três). PURA. */
export function roundChoiceOf(selected: readonly string[] | undefined): RoundAnswer["choice"] | null {
  if ((selected ?? []).includes(EXTRA_ROUND_OPTION_ID)) return "extra";
  if ((selected ?? []).includes(STOP_OPTION_ID)) return "stop";
  if ((selected ?? []).includes(ACCEPT_OPTION_ID)) return "accept";
  return null;
}

/**
 * O CICLO da raiz: o intervalo de commits revisado e o modo (reaberta para refinar/corrigir). Um ciclo novo — código novo
 * ou a raiz reaberta — faz «Aceitar»/«Parar» de antes deixarem de valer. PURA.
 */
export function cycleOf(root: Partial<Pick<Card, "commitRange" | "mode">> | null | undefined): string {
  return `${root?.commitRange?.head ?? "-"}|${root?.mode ?? "-"}`;
}

const keyOf = (board: string, id: string) => `${board}/${id}`;
const isLegacyRound = (c: BoardCard["card"]): boolean => !c.reviewChain && (c.labels ?? []).some((l) => REVIEW_ROUND_LABELS.has(l));
const legacyOrigin = (c: BoardCard["card"]): string | null => c.links?.find((l) => l.rel === "relates-to")?.to ?? null;

/**
 * A raiz da cadeia de um card: a marca dele; sem marca, a régua antiga (sobe pelo `relates-to` enquanto o card for
 * rodada rotulada, no mesmo board); senão o próprio card. PURA.
 */
export function chainRootOf(board: string, cardId: string, all: readonly BoardCard[]): string {
  const byKey = new Map(all.map((x) => [keyOf(x.board, x.card.id), x] as const));
  const seen = new Set<string>();
  let cur = byKey.get(keyOf(board, cardId));
  let last = keyOf(board, cardId);
  while (cur && !seen.has(keyOf(cur.board, cur.card.id))) {
    const k = keyOf(cur.board, cur.card.id);
    seen.add(k);
    last = k;
    if (cur.card.reviewChain) return cur.card.reviewChain.root;
    if (!isLegacyRound(cur.card)) return k;
    const prev = legacyOrigin(cur.card);
    if (!prev) return k;
    cur = byKey.get(keyOf(cur.board, prev));
  }
  return last;
}

/** A árvore da raiz: a raiz (se existe) e todos os cards dela — marcados, ou rodadas antigas penduradas num membro. PURA. */
export function chainTree(root: string, all: readonly BoardCard[]): { root: BoardCard | null; members: BoardCard[] } {
  const rootCard = all.find((x) => keyOf(x.board, x.card.id) === root) ?? null;
  const inTree = new Set<string>([root]);
  const members: BoardCard[] = [];
  for (const x of all) {
    const k = keyOf(x.board, x.card.id);
    if (k !== root && x.card.reviewChain?.root === root) {
      inTree.add(k);
      members.push(x);
    }
  }
  // rodadas antigas (sem marca): rótulo + relates-to para um card da árvore no mesmo board — até o ponto fixo
  for (let grew = true; grew; ) {
    grew = false;
    for (const x of all) {
      const k = keyOf(x.board, x.card.id);
      if (inTree.has(k) || !isLegacyRound(x.card)) continue;
      const prev = legacyOrigin(x.card);
      if (prev && inTree.has(keyOf(x.board, prev))) {
        inTree.add(k);
        members.push(x);
        grew = true;
      }
    }
  }
  return { root: rootCard, members };
}

const capQuestions = (c: BoardCard["card"]): CardQuestion[] => (c.questions ?? []).filter((q) => q.text.startsWith(ROUNDS_CAP_QUESTION_PREFIX));

/** A pergunta do teto num card (a mais recente), ou null. PURA. */
export function roundsCapQuestion(card: Pick<Card, "questions">): CardQuestion | null {
  const qs = (card.questions ?? []).filter((q) => q.text.startsWith(ROUNDS_CAP_QUESTION_PREFIX));
  return qs.length ? qs[qs.length - 1] : null;
}

/** O card tem a pergunta do teto ABERTA? (a mudança de board a recusa — card-transfer.ts). PURA. */
export function hasOpenRoundsCapQuestion(card: Pick<Card, "questions">): boolean {
  return (card.questions ?? []).some((q) => q.status === "open" && q.text.startsWith(ROUNDS_CAP_QUESTION_PREFIX));
}

export type ReviewRoundState =
  /** abaixo do teto: abra a rodada */
  | "open"
  /** no teto, com uma rodada que o dono pagou e não foi usada */
  | "open-extra"
  /** no teto: pergunte ao dono */
  | "ask"
  /** a pergunta já está aberta em algum card da árvore */
  | "pending"
  /** o dono aceitou o risco restante: não abre, não pergunta de novo */
  | "accepted"
  /** o dono mandou parar: não abre, não pergunta de novo */
  | "stopped";

export interface ReviewRoundVerdict {
  state: ReviewRoundState;
  /** a raiz da cadeia. */
  root: string;
  /** quantas rodadas a árvore já tem (a raiz conta como 1). */
  rounds: number;
  /** a marca que o conserto que nascer agora carrega (só com `open`/`open-extra`). */
  mark: ReviewChainMark | null;
}

/**
 * Pode abrir mais uma rodada a partir de `fromBoard/fromId`? Conta a árvore inteira da raiz. Abaixo do teto, sim. No
 * teto, só com uma rodada extra paga e não usada (cada «Pagar mais uma rodada» REGISTRADA pelo servidor vale UMA; contam
 * como usadas as rodadas marcadas `extra`). Sem ela: pergunta aberta na árvore ⇒ `pending`; a última resposta
 * «Aceitar»/«Parar» do CICLO atual da raiz ⇒ `accepted`/`stopped` — salvo `severe` (achado bloqueante), que pergunta de
 * novo; senão ⇒ `ask`. `answers` são as do registro do servidor (as do frontmatter não contam). PURA.
 */
export function reviewRoundVerdict(
  fromBoard: string,
  fromId: string,
  all: readonly BoardCard[],
  cap: number,
  opts: { answers?: readonly RoundAnswer[]; severe?: boolean } = {},
): ReviewRoundVerdict {
  const root = chainRootOf(fromBoard, fromId, all);
  const tree = chainTree(root, all);
  const rounds = 1 + tree.members.length;
  const mark = (extra: boolean): ReviewChainMark => ({ root, round: rounds + 1, ...(extra ? { extra: true } : {}) });
  if (rounds < cap) return { state: "open", root, rounds, mark: mark(false) };

  const answers = (opts.answers ?? []).filter((a) => a.root === root).sort((a, b) => a.at.localeCompare(b.at));
  const granted = answers.filter((a) => a.choice === "extra").length;
  const used = tree.members.filter((x) => x.card.reviewChain?.extra || (x.card.labels ?? []).includes(EXTRA_ROUND_LABEL)).length;
  if (granted > used) return { state: "open-extra", root, rounds, mark: mark(true) };
  const everyone = [...(tree.root ? [tree.root] : []), ...tree.members];
  if (everyone.some((x) => capQuestions(x.card).some((q) => q.status === "open"))) return { state: "pending", root, rounds, mark: null };
  if (!opts.severe) {
    const cycle = cycleOf(tree.root?.card);
    const last = [...answers].reverse().find((a) => a.choice !== "extra");
    if (last && last.cycle === cycle) return { state: last.choice === "accept" ? "accepted" : "stopped", root, rounds, mark: null };
  }
  return { state: "ask", root, rounds, mark: null };
}

/** A resposta do dono à pergunta do teto mandou PARAR? (o card da pergunta é adiado — answerQuestionAction). PURA. */
export function isStopAnswer(question: Pick<CardQuestion, "text" | "selectedOptionIds">): boolean {
  return question.text.startsWith(ROUNDS_CAP_QUESTION_PREFIX) && (question.selectedOptionIds ?? []).includes(STOP_OPTION_ID);
}

/** A pergunta ao dono quando a cadeia chega ao teto — linguagem simples, classe dinheiro (mais uma rodada custa). PURA. */
export function roundsCapQuestionInput(input: { title: string; rounds: number | null; summary: string }): StructuredQuestionInput {
  return {
    // `rounds: null` = a contagem não pôde ser conferida (um board não foi lido): pergunta ao dono em vez de contar a menos
    text:
      input.rounds == null
        ? `${ROUNDS_CAP_QUESTION_PREFIX} a revisão de «${input.title}» pediu mais um conserto, mas não consegui conferir quantas rodadas já houve (um board não foi lido). Como seguir?`
        : `${ROUNDS_CAP_QUESTION_PREFIX} a revisão de «${input.title}» achou problema de novo, depois de ${input.rounds} rodadas. Como seguir?`,
    context:
      `O que ficou aberto: ${input.summary.trim() || "veja os avisos do card"}. ` +
      "Cada rodada é uma sessão inteira de agente; uma checagem por leitura de código pode nunca fechar em 100%.",
    options: [
      { label: ROUNDS_CAP_OPTIONS[0], pros: ["Sem gasto novo; o card segue com os avisos registrados e não se pergunta de novo"], cons: ["O risco que sobrou fica"] },
      { label: ROUNDS_CAP_OPTIONS[1], pros: ["Mais uma tentativa de fechar os avisos"], cons: ["Mais uma sessão de agente paga"] },
      {
        label: ROUNDS_CAP_OPTIONS[2],
        pros: ["O card fica adiado: nenhum agente gasta mais nele nem o leva adiante rumo ao ar"],
        cons: ["O trabalho para onde está; o que já foi integrado antes continua integrado"],
      },
    ],
    mode: "single",
    category: "money",
    ownerClass: "money",
  };
}

/**
 * O card tem achados de REVISÃO abertos? (lente de revisão — segurança, testes, desempenho, design ou as do alvo —, não
 * os avisos gerais do sistema, de severidade média para cima). É o que faz um card novo de um agente nesta sessão herdar
 * a cadeia sozinho (MCP `create_card`), mesmo sem `continuesFrom`. PURA.
 */
export function hasOpenReviewFindings(card: Pick<Card, "findings"> | null | undefined): boolean {
  return (card?.findings ?? []).some((f) => f.status === "open" && isReviewFinding(f));
}

/** Achado de REVISÃO (lente de revisão, severidade média para cima) — a régua de {@link hasOpenReviewFindings}. PURA. */

/**
 * O card CARREGA uma cadeia de conserto de revisão? — o que faz uma entrega criada pela sessão que o conduz herdar a
 * cadeia sozinha. Vale quando o card já é rodada (`reviewChain`), quando tem achados de revisão abertos, ou quando um
 * achado de revisão dele foi fechado por um AGENTE (`statusBy` que não é humano): fechar os achados com `triage_finding`
 * não pode desligar a herança dentro da mesma sessão — só o dono (ou a revisão de novo) encerra a cadeia. PURA.
 */
export function cardCarriesReviewChain(card: Pick<Card, "findings" | "reviewChain"> | null | undefined): boolean {
  if (!card) return false;
  if (card.reviewChain) return true;
  return (card.findings ?? []).some((f) => isReviewFinding(f) && (f.status === "open" || (f.statusBy != null && f.statusBy !== "human")));
}

/** `a` e `b` estão na MESMA árvore de cadeia (a mesma raiz)? PURA. */
export function sameReviewTree(a: { board: string; id: string }, b: { board: string; id: string }, all: readonly BoardCard[]): boolean {
  return chainRootOf(a.board, a.id, all) === chainRootOf(b.board, b.id, all);
}
