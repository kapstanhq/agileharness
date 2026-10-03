// DECISÕES REGISTRADAS — os dilemas técnicos que afetam o produto (política só-negócio). PURA (zero IO).
//
// Um dilema é um trade-off técnico com efeito no produto: cortar escopo para cumprir uma data, trocar um critério
// de aceite caro por um mais barato, adiar um estado de erro. Em só-negócio o dono não é chamado para isso — o
// responsável (o condutor, o proxy) decide pelo que mais serve à META PRINCIPAL do PRD e deixa no card, durável: o
// quê, as opções, a escolha, o porquê preso ao PRD e como desfazer. Nada para; o dono vê em "Acompanhar" e pode
// desfazer (a razão dele vira um achado aberto no card, que o próximo agente trata como parte do contrato).
//
// A fronteira: um dilema que toca uma classe do DONO (mudar uma meta do PRD, gastar, falar pela marca, dados de
// pessoas) NÃO é decisão registrada — é pergunta a ele (`ask_question`, categoria owner). E em modo human todo
// dilema é do dono. A régua é a mesma de todo ponto de parada: decision-class.ts `whoDecides`.

import { whoDecides } from "./decision-class";
import type { BoardConfig, Card, RecordedDecision } from "./types";

/** O que o responsável informa ao registrar um dilema. */
export interface RecordedDecisionInput {
  what: string;
  options: string[];
  choice: string;
  why: string;
  prdAnchor?: string;
  undo: string;
  /** a classe do dono que o dilema toca, quando toca — então ele NÃO é registrável: é pergunta ao dono. */
  ownerClass?: string | null;
}

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 6;

/** Por que o registro está incompleto — ou null. PURA. */
export function recordedDecisionError(input: RecordedDecisionInput): string | null {
  if (!input.what?.trim()) return "diga o quê está sendo decidido";
  const options = (input.options ?? []).map((o) => o.trim()).filter(Boolean);
  if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS || new Set(options).size !== options.length) {
    return `dê de ${MIN_OPTIONS} a ${MAX_OPTIONS} opções distintas (um dilema tem alternativas)`;
  }
  if (!options.includes(input.choice?.trim() ?? "")) return "a escolha precisa ser uma das opções";
  if (!input.why?.trim()) return "diga o porquê, preso à meta principal do PRD";
  if (!input.undo?.trim()) return "diga como desfazer a escolha";
  return null;
}

/**
 * Por que este dilema NÃO pode ser decidido e registrado pelo sistema — ou null. A MESMA régua de todo ponto de
 * parada: em human o dilema é do dono; em só-negócio, um que toque uma classe do dono também. PURA.
 */
export function recordedDecisionRefusal(
  card: Pick<Card, "autonomyMode" | "businessClasses">,
  config: Pick<BoardConfig, "autonomy">,
  input: Pick<RecordedDecisionInput, "ownerClass">,
): string | null {
  const verdict = whoDecides({ kind: "dilemma", ownerClass: input.ownerClass ?? null }, card, config);
  if (verdict.decider === "system") return null;
  return `este dilema é decisão do dono (${verdict.reason}) — pergunte com ask_question em vez de registrar`;
}

/** Próximo id livre (`d<N>`, nunca reusa). */
function nextDecisionId(existing: readonly RecordedDecision[]): string {
  let max = 0;
  for (const d of existing) {
    const m = /^d(\d+)$/.exec(d.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `d${max + 1}`;
}

/** Acrescenta a decisão (chame {@link recordedDecisionError} antes). PURA. */
export function appendRecordedDecision(
  existing: readonly RecordedDecision[],
  input: RecordedDecisionInput,
  opts: { by: string; at: string },
): RecordedDecision[] {
  const decision: RecordedDecision = {
    id: nextDecisionId(existing),
    what: input.what.trim(),
    options: input.options.map((o) => o.trim()).filter(Boolean),
    choice: input.choice.trim(),
    why: input.why.trim(),
    ...(input.prdAnchor?.trim() ? { prdAnchor: input.prdAnchor.trim() } : {}),
    undo: input.undo.trim(),
    by: opts.by,
    at: opts.at,
  };
  return [...existing, decision];
}

/** O dono DESFAZ uma decisão: marca-a uma vez (a segunda não muda nada — mesmo array). PURA. */
export function revertRecordedDecision(
  existing: RecordedDecision[],
  id: string,
  opts: { by: string; at: string; note?: string },
): RecordedDecision[] {
  const target = existing.find((d) => d.id === id);
  if (!target || target.reverted) return existing;
  return existing.map((d) =>
    d.id === id ? { ...d, reverted: { by: opts.by, at: opts.at, ...(opts.note?.trim() ? { note: opts.note.trim() } : {}) } } : d,
  );
}
