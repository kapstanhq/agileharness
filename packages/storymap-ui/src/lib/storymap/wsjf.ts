// WSJF ANCORADO — a régua de prioridade do board. Puro, zero IO.
//
// Por que ancorado e não relativo: priorizar é ordenar um item CONTRA os outros, mas re-ranquear o
// conjunto inteiro a cada card novo (a) embaralha cards que o operador já julgou, (b) torna o número
// irreprodutível fora daquele instante, e (c) custa uma passada de LLM por card que chega. A saída é a
// prática canônica do WSJF (SAFe): cada item recebe ORDINAIS numa escala ABSOLUTA e FECHADA, estimados
// contra um punhado de itens já pontuados (as ÂNCORAS / reference stories), e a ORDEM cai da aritmética.
// Ninguém precisa mexer no score alheio para um card novo achar seu lugar.
//
//   CoD  = valor + urgência + destravamento     cada termo ∈ FIB   →  CoD ∈ [3, 39]
//   WSJF = CoD / tamanho                        tamanho ∈ FIB      →  WSJF ∈ [0,23 , 39]
//
// Os TRÊS termos do numerador existem por razões distintas e nenhum é decorativo:
//   • valor         — quanto move o resultado-alvo do board.
//   • urgência      — quanto o custo CRESCE com a espera (é onde vive o bug bloqueante: ele não entrega
//                     nada novo, então morreria com um "valor" só).
//   • destravamento — quantas outras coisas passam a ser possíveis. É o termo que faz a SEQUÊNCIA
//                     emergir; sem ele, card de alicerce (que soa entediante) afunda — exatamente o que
//                     quebra o cenário "PRD gerou 40 cards".
//
// A escala é Fibonacci porque a incerteza cresce com o tamanho: distinguir 1 de 2 é honesto, distinguir
// 12 de 13 é teatro. Domínio fechado ⇒ um 8 de janeiro significa o mesmo que um 8 de junho.
//
// Os CORTES de tier moram na spec (settings.yaml → prioritization.tiers), nunca como constante de
// produto — este pacote é ferramenta genérica (ver .claude/CLAUDE.md). Os defaults abaixo são a régua
// documentada em storymap/frameworks.md §4; mantenha os dois em sincronia.

import type { Card } from "./types";

/** A escala ordinal fechada — a MESMA para os quatro termos. */
export const FIB = [1, 2, 3, 5, 8, 13] as const;
export type Fib = (typeof FIB)[number];

/**
 * Os cortes default de tier (WSJF ≥ corte) — uma escala por DOBRA: 2 → 4 → 8.
 *
 * Não são chute: enumerando os 6⁴ = 1296 pontos do domínio, ponderados pela plausibilidade de cada
 * ordinal num backlog real (os do meio são muito mais comuns que os extremos), os quartis caem em
 * p25 ≈ 2,0 · p50 ≈ 3,5 · p75 ≈ 6,0 · p90 ≈ 9,0. Os cortes por dobra encaixam nesses quartis e
 * produzem Baixa 23% / Média 32% / Alta 30% / Crítica 15%. Cortes mais frouxos ({6,3,1.5}) marcavam
 * 26% do backlog como Crítica — inflação que faz o tier deixar de discriminar, que é o modo de falha
 * clássico de qualquer rubrica de prioridade.
 *
 * ⚠️ TETO ESTRUTURAL, e ele é intencional: como CoD ≤ 39, um card de tamanho 13 nunca passa de
 * WSJF 3,0 (teto Média) e um de tamanho 8 não passa de 4,9 (teto Alta). Isto é o WSJF funcionando —
 * o "SHORTEST" do nome. Um item grande e genuinamente crítico não sobe de tier argumentando: ele é
 * QUEBRADO em fatias menores, e aí cada fatia disputa em pé de igualdade.
 *
 * Sobrepostos por board em `settings.yaml → prioritization.tiers` (este pacote é ferramenta genérica).
 */
export const DEFAULT_TIER_CUTS = { critica: 8, alta: 4, media: 2 } as const;
export type TierCuts = { critica: number; alta: number; media: number };

/**
 * Os quatro ordinais + a PROVENIÊNCIA do julgamento. Sub-bloco ADITIVO de `priorityCall` — nasce
 * opcional para que os calls legados (só `rank` + `rationale`) sigam válidos sem migração nenhuma.
 */
export interface WsjfCall {
  /** quanto move o resultado-alvo do board */
  value: Fib;
  /** quanto o custo CRESCE com a espera (urgência ≠ importância) */
  urgency: Fib;
  /** quantas outras coisas passam a ser possíveis quando isto existe */
  unlock: Fib;
  /** tamanho do trabalho (job size) — o denominador */
  size: Fib;
  /** que SINAIS existiam quando o julgamento foi feito (ex.: soThat, aceite, personas, entrevista,
   *  severidade, esforco, entregues). Vira a CONFIANÇA exibida — impede o motor de soar certo sobre
   *  um card nu. */
  basis: string[];
  /** quantos cards estavam na fila quando este foi pontuado (contexto do julgamento) */
  cohortSize: number;
  /** ISO — SEMPRE string. O YAML parseia ISO nu como Date; ver storymap-new-card-field-needs-serializer. */
  cohortAt: string;
}

const isFib = (n: unknown): n is Fib => (FIB as readonly number[]).includes(n as number);

/** Coage um número qualquer para o ordinal Fibonacci mais próximo (o LLM às vezes devolve 4, 6, 10). */
export function toFib(n: unknown): Fib | null {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v) || v <= 0) return null;
  let best: Fib = FIB[0];
  for (const f of FIB) if (Math.abs(f - v) < Math.abs(best - v)) best = f;
  return best;
}

/**
 * A razão WSJF. `null` quando o bloco está ausente ou fora da escala — NUNCA 0 e nunca divide por
 * zero: um score inválido tem de sumir da ordenação, não virar "prioridade mínima" (que empataria com
 * um card legitimamente avaliado como Baixa).
 */
export function wsjfRatio(w?: WsjfCall | null): number | null {
  if (!w) return null;
  if (![w.value, w.urgency, w.unlock, w.size].every(isFib)) return null;
  return (w.value + w.urgency + w.unlock) / w.size;
}

/** O tier (0 Baixa · 1 Média · 2 Alta · 3 Crítica) por FAIXA ABSOLUTA sobre a razão.
 *  Faixa absoluta e não percentil: com percentil, entrar um card remexe o tier de cards alheios e o
 *  `rank` gravado deixa de significar algo fora daquele instante. */
export function wsjfTier(score: number | null, cuts: TierCuts = DEFAULT_TIER_CUTS): 0 | 1 | 2 | 3 | null {
  if (score == null) return null;
  if (score >= cuts.critica) return 3;
  if (score >= cuts.alta) return 2;
  if (score >= cuts.media) return 1;
  return 0;
}

export type Confidence = "alta" | "media" | "baixa";

/** Confiança = quantos sinais REAIS existiam no momento do julgamento (não quão seguro o texto soa). */
export function wsjfConfidence(basis: string[] | undefined | null): Confidence {
  const n = basis?.length ?? 0;
  return n >= 5 ? "alta" : n >= 3 ? "media" : "baixa";
}

/**
 * GUARDA ANTI-DEGENERADO — determinística, sem 2ª chamada de LLM.
 * Um lote em que TODOS os cards recebem o mesmo tamanho E o mesmo valor não discrimina nada: a "ordem"
 * resultante é ordem de id disfarçada de ranking. Melhor FALHAR ALTO do que gravar isso — foi
 * exatamente esse tipo de ranking fantasma (lista alfabética com cara de ordem) que motivou o
 * redesenho. Só vale a partir de 5 itens; abaixo disso empate é plausível.
 */
export function isDegenerate(items: Array<Pick<WsjfCall, "value" | "size">>): boolean {
  if (items.length < 5) return false;
  const uniq = (xs: number[]) => new Set(xs).size;
  return uniq(items.map((i) => i.size)) === 1 && uniq(items.map((i) => i.value)) === 1;
}

// ── A régua de LEITURA que todo consumidor usa ────────────────────────────────────────────────────

/** O score de um card. Call legado (só `rank`) → null: ele ordena pelo rank, não pela razão. */
export function cardWsjf(card: Card): number | null {
  return wsjfRatio(card.priorityCall?.wsjf);
}

/**
 * Ordem total do backlog, alta prioridade primeiro. Três degraus e um desempate:
 *   1. o TIER persistido (`rank`) — é o que o gate isomórfico e o `suggest_work` leem cru;
 *   2. a razão WSJF, que desempata DENTRO do tier;
 *   3. avaliado SEMPRE antes de não-avaliado — a mesma regra de honestidade da tela;
 *   4. o id, para a ordem ser total (determinismo, não preferência).
 */
export function comparePriority(a: Card, b: Card): number {
  const ra = a.priorityCall?.rank ?? -1;
  const rb = b.priorityCall?.rank ?? -1;
  if (ra !== rb) return rb - ra;
  const wa = cardWsjf(a);
  const wb = cardWsjf(b);
  if (wa != null && wb != null && wa !== wb) return wb - wa;
  if ((wa == null) !== (wb == null)) return wa == null ? 1 : -1;
  return a.id.localeCompare(b.id);
}

/** Coage um objeto cru (disco ou resposta do LLM) num WsjfCall válido; null quando não dá. */
export function coerceWsjf(raw: unknown): WsjfCall | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const value = toFib(r.value);
  const urgency = toFib(r.urgency);
  const unlock = toFib(r.unlock);
  const size = toFib(r.size);
  if (value == null || urgency == null || unlock == null || size == null) return null;
  const basis = Array.isArray(r.basis) ? r.basis.map((b) => String(b)).filter(Boolean) : [];
  const cohortSize = Number.isFinite(Number(r.cohortSize)) ? Number(r.cohortSize) : 0;
  // String() é obrigatório: o YAML entrega um ISO nu como Date, e um Date aqui quebra o round-trip.
  const cohortAt = r.cohortAt != null ? String(r.cohortAt) : "";
  return { value, urgency, unlock, size, basis, cohortSize, cohortAt };
}
