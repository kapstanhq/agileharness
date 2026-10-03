// Prioridade ARGUMENTADA (reasoning-first) — os helpers PUROS da avaliação por raciocínio que substitui
// o alcance×impacto. O PROMPT aqui É a metodologia: pede ao assistente que pese um card contra a
// estratégia do produto + os irmãos e devolva um TIER DEFENDIDO (não um número de alcance inventado).
// Mantido puro + agnóstico de servidor para ser testável; a server action (app/priority-actions.ts)
// liga a chamada do LLM + a persistência.

import { strategyOrAbsence } from "./doc/prd-digest";
import type { Card } from "./types";

export type PriorityAssessment = {
  rank: 0 | 1 | 2 | 3;
  rationale: string;
  riskiestAssumption?: string | null;
};

const TIER_NAMES = ["Baixa", "Média", "Alta", "Crítica"] as const;

/** True quando o card carrega dor (idea) — a prioridade mora no bloco idea, não no topo. */
function isIdea(card: Card): boolean {
  return card.type === "idea";
}

function currentCall(card: Card) {
  return isIdea(card) ? card.idea?.priorityCall ?? null : card.priorityCall ?? null;
}

/** Uma linha compacta de um card para a lista de irmãos (ranqueamento relativo). */
export function priorityCardLine(card: Card): string {
  const title = (isIdea(card) ? card.idea?.statement : card.title)?.trim() || card.title;
  const pc = currentCall(card);
  return pc ? `${title} [tier atual: ${TIER_NAMES[pc.rank]}]` : title;
}

/** Os detalhes do card-foco — o que o assistente lê para julgar. */
function focusDetails(card: Card): string {
  if (isIdea(card)) {
    const o = card.idea;
    return [
      `Dor: ${o?.statement?.trim() || card.title}`,
      o?.evidence ? `Evidência: ${o.evidence}` : null,
      o?.keyAssumption ? `Premissa-chave: ${o.keyAssumption}` : null,
      o?.successSignal ? `Sinal de sucesso: ${o.successSignal}` : null,
      o?.candidateSolutions?.length ? `Soluções candidatas: ${o.candidateSolutions.join("; ")}` : null,
    ]
      .filter(Boolean)
      .join("\n");
  }
  return [
    `Título: ${card.title}`,
    card.narrative?.soThat ? `Benefício: ${card.narrative.soThat}` : null,
    card.acceptance?.length ? `Critérios de aceite: ${card.acceptance.slice(0, 5).join("; ")}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

// A régua compartilhada por ambos os prompts (single + batch) — a metodologia em prosa.
const METHODOLOGY = [
  "Você é o Jido de PRIORIZAÇÃO do AgileHarness. Sua régua é RACIOCÍNIO, não aritmética de alcance:",
  "num produto pré-escala, número de \"alcance\" é chute — o que vale é o ARGUMENTO de por que algo",
  "importa AGORA, ancorado na estratégia do produto e comparado com o resto do backlog.",
  "",
  "Atribua um TIER nesta escala:",
  "  3 Crítica — faça primeiro: destrava outras coisas, ou sua ausência corrói o núcleo do produto.",
  "  2 Alta — forte alavanca no resultado-alvo / fit central com o posicionamento.",
  "  1 Média — importa, mas pode esperar sem dano relevante.",
  "  0 Baixa — pouca alavanca agora.",
  "",
  "Raciocine sobre, NESTA ordem de peso:",
  "  1. Alavanca no resultado-alvo e fit com o posicionamento.",
  "  2. Força da EVIDÊNCIA (dor observada pesa mais que especulação).",
  "  3. Custo de NÃO fazer agora (destrava? corrói confiança? bloqueia outras?).",
  "  4. Posição RELATIVA frente aos outros itens — NÃO infle tudo para Alta/Crítica.",
  "",
  "Escreva um PORQUÊ de 1 a 3 frases (\"por que agora / por que antes de X\") e nomeie a ÚNICA",
  "suposição mais arriscada a testar primeiro (Lean).",
].join("\n");

/** Prompt para avaliar UM card (ranqueando-o de forma relativa contra os irmãos). */
export function buildPriorityAssessPrompt(input: { strategy: string; card: Card; siblings: Card[] }): string {
  const { card, siblings } = input;
  const siblingLines = siblings.length
    ? siblings.map((c, i) => `${i + 1}. ${priorityCardLine(c)}`).join("\n")
    : "(nenhum outro item ainda)";
  return [
    METHODOLOGY,
    "",
    "# Estratégia do produto (o norte)",
    strategyOrAbsence(input.strategy),
    "",
    "# O item a priorizar",
    focusDetails(card),
    "",
    "# Os outros itens do backlog (para ranquear de forma RELATIVA)",
    siblingLines,
    "",
    "# Responda APENAS com JSON, sem cercas de código:",
    '{"rank": <0-3>, "rationale": "<1 a 3 frases>", "riskiestAssumption": "<a suposição mais arriscada>"}',
  ].join("\n");
}

/** Prompt para RANQUEAR todos os itens de uma vez (ordenação relativa em um passe). */
export function buildPriorityReorderPrompt(input: { strategy: string; cards: Card[] }): string {
  const { cards } = input;
  const list = cards.map((c, i) => `${i + 1}. [id: ${c.id}] ${priorityCardLine(c)}`).join("\n");
  return [
    METHODOLOGY,
    "",
    "# Estratégia do produto (o norte)",
    strategyOrAbsence(input.strategy),
    "",
    "# Os itens a ranquear (todos de uma vez, de forma RELATIVA entre si)",
    list,
    "",
    "Distribua os tiers com critério — a maioria NÃO deve ser Crítica. Reserve Crítica para o que",
    "realmente destrava ou corrói o núcleo. Cada item recebe um porquê curto e a suposição mais arriscada.",
    "",
    "# Responda APENAS com JSON, sem cercas de código:",
    '{"items": [{"id": "<id>", "rank": <0-3>, "rationale": "<1 a 2 frases>", "riskiestAssumption": "<suposição>"}, ...]}',
  ].join("\n");
}

// ── Parsing — tolerante a cercas de código e preâmbulo ──────────────────────────────────────────────

function extractJson(raw: string): unknown {
  let s = raw.trim();
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

function coerceAssessment(o: unknown): PriorityAssessment | null {
  if (!o || typeof o !== "object") return null;
  const r = o as Record<string, unknown>;
  const rank = Number(r.rank);
  if (![0, 1, 2, 3].includes(rank)) return null;
  const rationale = typeof r.rationale === "string" ? r.rationale.trim() : "";
  if (!rationale) return null;
  const ra =
    typeof r.riskiestAssumption === "string" && r.riskiestAssumption.trim()
      ? r.riskiestAssumption.trim()
      : undefined;
  return { rank: rank as 0 | 1 | 2 | 3, rationale, riskiestAssumption: ra };
}

/** Parse a single assessment from the assistant's raw text; null when it didn't return valid JSON. */
export function parsePriorityAssessment(raw: string): PriorityAssessment | null {
  const obj = extractJson(raw);
  return obj ? coerceAssessment(obj) : null;
}

/** Parse the batch `{items:[...]}` reorder result; drops malformed entries, null when none survive. */
export function parsePriorityBatch(raw: string): Array<PriorityAssessment & { id: string }> | null {
  const obj = extractJson(raw) as { items?: unknown } | null;
  if (!obj || !Array.isArray(obj.items)) return null;
  const out: Array<PriorityAssessment & { id: string }> = [];
  for (const it of obj.items) {
    if (!it || typeof it !== "object") continue;
    const id = typeof (it as Record<string, unknown>).id === "string" ? ((it as Record<string, unknown>).id as string) : null;
    const a = coerceAssessment(it);
    if (id && a) out.push({ id, ...a });
  }
  return out.length ? out : null;
}
