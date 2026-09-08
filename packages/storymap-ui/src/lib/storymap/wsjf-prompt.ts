// O PROMPT de pontuação WSJF + o parser da resposta. Puro (string in/string out) para ser testável
// sem LLM; quem liga o modelo e persiste é a server action.
//
// O modelo emite APENAS os quatro ordinais + o porquê. Nada derivado passa por ele: a razão, o tier,
// a ordem, a confiança e as guardas são aritmética em código. Isso é deliberado — um número que o
// modelo "calcula" não é auditável nem reprodutível, e a ordem do backlog precisa ser as duas coisas.

import type { PriorityContext } from "./priority-context";
import { FIB, toFib, type Fib } from "./wsjf";

/** A régua, em prosa, para o modelo. Espelha o doc-comment de wsjf.ts e frameworks.md §4. */
const RUBRICA = [
  "Você pontua itens de backlog pela régua WSJF (Weighted Shortest Job First).",
  "",
  `Cada eixo usa ESTA escala fechada e nenhum outro número: ${FIB.join(", ")}.`,
  "",
  "  VALOR       — quanto isto move o resultado-alvo declarado do produto.",
  "  URGÊNCIA    — quanto o custo CRESCE com a espera. Urgência NÃO é importância: um defeito que",
  "                bloqueia gente hoje é urgentíssimo mesmo entregando pouco valor novo.",
  "  DESTRAVAMENTO — quantas OUTRAS coisas passam a ser possíveis quando isto existe. É aqui que",
  "                trabalho de alicerce (que soa entediante) ganha o peso que merece.",
  "  TAMANHO     — o esforço do trabalho. É o DENOMINADOR: item grande precisa de valor",
  "                proporcionalmente maior para subir. Item enorme e importante deve ser QUEBRADO,",
  "                não inflado.",
  "",
  "Regras que não se negociam:",
  "  1. Pontue contra as ÂNCORAS quando existirem — elas são a régua CALIBRADA deste board. Um item",
  "     equivalente a uma âncora recebe ordinais equivalentes. Não invente uma escala própria.",
  "  2. NÃO infle. Se tudo receber valor alto, a ordem não informa nada. Use a escala inteira,",
  "     inclusive 1 e 2.",
  "  3. Julgue pelo que está ESCRITO. Card sem evidência recebe ordinais modestos — isso é honesto,",
  "     e o sistema registra separadamente que a evidência era fina.",
  "  4. NÃO repriorize as âncoras nem os itens da fila. Pontue SOMENTE os itens pedidos.",
  "  5. O que o produto JÁ FAZ é contexto: um item que apenas repete capacidade existente vale pouco;",
  "     um item que completa algo já entregue pela metade costuma destravar muito.",
].join("\n");

const seção = (título: string, corpo: string): string | null =>
  corpo && corpo.trim() ? `# ${título}\n${corpo.trim()}` : null;

/**
 * O prompt. O MESMO para o caminho incremental (1 alvo) e para o semeio (N alvos) — a única
 * diferença é quantos itens estão em "itens a pontuar" e se há âncoras. Uma superfície só, porque
 * duas descrições da mesma tarefa apodrecem em ritmos diferentes.
 */
export function buildWsjfPrompt(ctx: PriorityContext): string {
  const semÂncora = ctx.anchors.length === 0;
  return [
    RUBRICA,
    "",
    seção("O norte do produto", ctx.strategy) ??
      "# O norte do produto\n(não declarado — pontue com cautela e evite tiers altos)",
    "",
    seção("O que o produto JÁ FAZ hoje (entregue — contexto, NÃO pontue)", ctx.deliveredText),
    "",
    semÂncora
      ? [
          "# Âncoras",
          "(nenhuma ainda — este é o PRIMEIRO lote deste board. Os ordinais que você der aqui viram a",
          "régua calibrada de todos os próximos itens, então distribua com cuidado: use a escala inteira",
          "e reserve os extremos para o que realmente os merece.)",
        ].join("\n")
      : seção("Âncoras — itens JÁ pontuados (a régua calibrada deste board)", ctx.anchorsText),
    "",
    seção("O resto da fila (com o que estes itens competem — NÃO pontue)", ctx.queueText),
    "",
    `# Os itens a pontuar (${ctx.targets.length})`,
    ctx.targetsText,
    "",
    "# Responda APENAS com JSON, sem cercas de código e sem preâmbulo:",
    '{"items":[{"id":"<id>","value":<n>,"urgency":<n>,"unlock":<n>,"size":<n>,' +
      '"rationale":"<1 a 2 frases: por que agora, e por que antes ou depois de qual outro item>",' +
      '"riskiestAssumption":"<a suposição que, se falsa, derruba a aposta>"}]}',
  ]
    .filter((x) => x !== null)
    .join("\n");
}

export interface WsjfScored {
  id: string;
  value: Fib;
  urgency: Fib;
  unlock: Fib;
  size: Fib;
  rationale: string;
  riskiestAssumption?: string;
}

export interface WsjfParseResult {
  items: WsjfScored[];
  /** ids pedidos que NÃO voltaram utilizáveis — a tela reporta em vez de fingir cobertura total. */
  missing: string[];
}

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

/**
 * Lê a resposta e devolve o que é utilizável MAIS o que faltou.
 *
 * Reportar o buraco é metade do contrato: a versão anterior descartava item malformado em silêncio, e
 * uma resposta com 22 de 30 itens virava "priorizado" sem ninguém notar os 8 sumidos.
 */
export function parseWsjfResponse(raw: string, requestedIds: string[]): WsjfParseResult {
  const want = new Set(requestedIds);
  const obj = extractJson(raw) as { items?: unknown } | null;
  const items: WsjfScored[] = [];
  const seen = new Set<string>();

  if (obj && Array.isArray(obj.items)) {
    for (const it of obj.items) {
      if (!it || typeof it !== "object") continue;
      const r = it as Record<string, unknown>;
      const id = typeof r.id === "string" ? r.id : null;
      // guarda: o modelo às vezes devolve item fora do conjunto pedido (âncora, item da fila).
      // Pontuar quem não foi pedido reescreveria julgamento alheio — descarte.
      if (!id || !want.has(id) || seen.has(id)) continue;
      const value = toFib(r.value);
      const urgency = toFib(r.urgency);
      const unlock = toFib(r.unlock);
      const size = toFib(r.size);
      const rationale = typeof r.rationale === "string" ? r.rationale.trim() : "";
      if (value == null || urgency == null || unlock == null || size == null || !rationale) continue;
      const ra = typeof r.riskiestAssumption === "string" && r.riskiestAssumption.trim() ? r.riskiestAssumption.trim() : undefined;
      seen.add(id);
      items.push({ id, value, urgency, unlock, size, rationale, ...(ra ? { riskiestAssumption: ra } : {}) });
    }
  }

  return { items, missing: requestedIds.filter((id) => !seen.has(id)) };
}
