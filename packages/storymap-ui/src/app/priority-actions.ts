"use server";

// Server actions da PRIORIDADE ARGUMENTADA (reasoning-first) — o agente avalia um card (ou ranqueia
// todos) contra a estratégia + os irmãos e grava um `priorityCall` {rank, rationale, riskiestAssumption}.
// O humano sobrepõe via setPriorityAction (source:"human" — manda sobre o agente). A prioridade mora no
// bloco idea quando o card é uma dor, e no topo do card quando é uma story.

import { requireSession } from "@/lib/auth/action-guard";
import { revalidatePath } from "next/cache";
import type { Card, PriorityCall } from "@/lib/storymap/types";
import { readBoardConfig, readCards } from "@/lib/storymap/repo";
import { updateCardOnDisk } from "@/lib/storymap/write";
import { runClaudeJson } from "@/lib/storymap/smart-capture/claude";
import {
  buildPriorityAssessPrompt,
  buildPriorityReorderPrompt,
  parsePriorityAssessment,
  parsePriorityBatch,
} from "@/lib/storymap/priority-assess";
import { buildPriorityContext, rankableCards } from "@/lib/storymap/priority-context";
import { boardStrategy } from "@/lib/storymap/board-strategy";
import { buildWsjfPrompt, parseWsjfResponse } from "@/lib/storymap/wsjf-prompt";
import { isDegenerate, wsjfRatio, wsjfTier, type WsjfCall } from "@/lib/storymap/wsjf";

type Result<T = unknown> = { ok: true; data?: T } | { ok: false; error: string };

function fail<T = unknown>(e: unknown): Result<T> {
  return { ok: false, error: e instanceof Error ? e.message : String(e) };
}

/** Persist a priorityCall on the right home: the idea block for a pain, the card top for a story. */
async function persistPriorityCall(boardId: string, cardId: string, pc: PriorityCall): Promise<Card | null> {
  return updateCardOnDisk(boardId, cardId, (fresh) => {
    if (fresh.type === "idea") {
      const prev = fresh.idea ?? { statement: fresh.title, evidence: null, status: "open" as const };
      return { ...fresh, idea: { ...prev, priorityCall: pc } };
    }
    return { ...fresh, priorityCall: pc };
  });
}

/** Revalidate every board view (the tier shows on the kanban, the bench, and the prioritization page). */
function revalidateBoard(boardId: string): void {
  revalidatePath(`/board/${boardId}`, "layout");
}

/** Avaliar a prioridade de UM card: o agente ranqueia-o de forma relativa contra os irmãos do mesmo tipo. */
export async function assessPriorityAction(input: {
  boardId: string;
  cardId: string;
}): Promise<Result<{ card: Card }>> {
  await requireSession("assessPriorityAction");
  try {
    const [config, cards] = await Promise.all([readBoardConfig(input.boardId), readCards(input.boardId)]);
    const strategy = await boardStrategy(input.boardId, config);
    const card = cards.find((c) => c.id === input.cardId);
    if (!card) return { ok: false, error: "Card não encontrado." };
    const siblings =
      card.type === "idea"
        ? cards.filter((c) => c.type === "idea" && c.id !== card.id)
        : cards.filter((c) => c.type === "story" && c.id !== card.id);
    const prompt = buildPriorityAssessPrompt({ strategy, card, siblings });
    const raw = await runClaudeJson(prompt, {
      context: { label: "Prioridade · avaliar", board: input.boardId, cardId: input.cardId },
    });
    const assessment = parsePriorityAssessment(raw);
    if (!assessment) return { ok: false, error: "O agente não retornou uma avaliação de prioridade válida." };
    const pc: PriorityCall = {
      rank: assessment.rank,
      rationale: assessment.rationale,
      ...(assessment.riskiestAssumption ? { riskiestAssumption: assessment.riskiestAssumption } : {}),
      source: "agent",
      assessedAt: new Date().toISOString(),
    };
    const updated = await persistPriorityCall(input.boardId, input.cardId, pc);
    if (!updated) return { ok: false, error: "Card não encontrado." };
    revalidateBoard(input.boardId);
    return { ok: true, data: { card: updated } };
  } catch (e) {
    return fail(e);
  }
}

/** Override HUMANO: fixa o tier (e, opcionalmente, o porquê) — source:"human" vence o agente. */
export async function setPriorityAction(input: {
  boardId: string;
  cardId: string;
  rank: 0 | 1 | 2 | 3;
  rationale?: string;
}): Promise<Result<{ card: Card }>> {
  await requireSession("setPriorityAction");
  try {
    if (![0, 1, 2, 3].includes(input.rank)) return { ok: false, error: "Tier inválido." };
    const updated = await updateCardOnDisk(input.boardId, input.cardId, (fresh) => {
      const prevCall = fresh.type === "idea" ? fresh.idea?.priorityCall : fresh.priorityCall;
      const rationale = input.rationale?.trim() || prevCall?.rationale || "Prioridade definida manualmente.";
      const pc: PriorityCall = {
        rank: input.rank,
        rationale,
        ...(prevCall?.riskiestAssumption ? { riskiestAssumption: prevCall.riskiestAssumption } : {}),
        source: "human",
        assessedAt: new Date().toISOString(),
      };
      if (fresh.type === "idea") {
        const prev = fresh.idea ?? { statement: fresh.title, evidence: null, status: "open" as const };
        return { ...fresh, idea: { ...prev, priorityCall: pc } };
      }
      return { ...fresh, priorityCall: pc };
    });
    if (!updated) return { ok: false, error: "Card não encontrado." };
    revalidateBoard(input.boardId);
    return { ok: true, data: { card: updated } };
  } catch (e) {
    return fail(e);
  }
}

/**
 * PONTUAR stories pela régua WSJF ancorada — o caminho canônico de prioridade de STORY.
 *
 * `cardIds` ausente ⇒ SEMEIO: pontua todo ranqueável ainda sem score (o caso "um PRD acabou de gerar
 * dezenas de cards"). Com ids ⇒ INCREMENTAL: pontua só aqueles contra as âncoras já calibradas, sem
 * tocar no score de mais ninguém. É por isso que a ordem é estável entre rodadas.
 *
 * Contratos que esta função garante:
 *  • um `priorityCall` com `source: "human"` NUNCA é sobrescrito — ele é o veto do operador, e vira
 *    ÂNCORA no prompt em vez de alvo. (A versão anterior gravava `source:"agent"` por cima de todo
 *    item devolvido, inclusive dos overrides humanos.)
 *  • cards em status TERMINAL ficam fora do cohort. Antes, 83–96% do que ia ao prompt era trabalho já
 *    entregue, sem nenhuma marca de que estava entregue — pedia-se ranqueamento "relativo" contra um
 *    conjunto majoritariamente morto.
 *  • um lote que não discrimina nada FALHA ALTO em vez de gravar ordem de id disfarçada de ranking.
 *  • o que não voltou utilizável é REPORTADO (`missing`), não engolido.
 */
export async function scoreStoriesAction(input: {
  boardId: string;
  cardIds?: string[];
}): Promise<Result<{ scored: number; missing: string[]; skippedHuman: number; total: number }>> {
  await requireSession("scoreStoriesAction");
  try {
    const [config, cards] = await Promise.all([readBoardConfig(input.boardId), readCards(input.boardId)]);

    const rankable = rankableCards(cards, config);
    if (rankable.length === 0) return { ok: false, error: "Nenhuma story em aberto para priorizar." };

    // O veto humano é imune ao lote e vira régua para os outros.
    const requested = input.cardIds?.length
      ? rankable.filter((c) => input.cardIds!.includes(c.id))
      : rankable.filter((c) => c.priorityCall?.wsjf == null);
    const targets = requested.filter((c) => c.priorityCall?.source !== "human");
    const skippedHuman = requested.length - targets.length;

    if (targets.length === 0) {
      return skippedHuman > 0
        ? { ok: false, error: "Só há prioridades definidas por você aqui — o agente não as sobrescreve." }
        : { ok: false, error: "Tudo já está priorizado." };
    }

    const ctx = buildPriorityContext({
      config,
      cards,
      strategy: await boardStrategy(input.boardId, config),
      targetIds: targets.map((c) => c.id),
    });
    const prompt = buildWsjfPrompt(ctx);
    const raw = await runClaudeJson(prompt, {
      timeoutMs: 300_000,
      context: { label: `Prioridade · pontuar ${targets.length}`, board: input.boardId },
    });

    const { items, missing } = parseWsjfResponse(raw, targets.map((c) => c.id));
    if (items.length === 0) {
      return { ok: false, error: "O agente não devolveu nenhuma pontuação utilizável." };
    }
    if (isDegenerate(items)) {
      // Sem variação em tamanho E valor, a "ordem" resultante é ordem de id. Melhor recusar do que
      // gravar um ranking fantasma — foi exatamente esse o defeito que motivou este redesenho.
      return {
        ok: false,
        error: "O agente deu a mesma nota a tudo — isso não é uma ordem. Nada foi gravado; tente de novo.",
      };
    }

    const now = new Date().toISOString();
    let scored = 0;
    for (const item of items) {
      const basis = ctx.basisById.get(item.id) ?? [];
      const wsjf: WsjfCall = {
        value: item.value,
        urgency: item.urgency,
        unlock: item.unlock,
        size: item.size,
        // "entregues" é sinal do CONTEXTO, não do card: só conta quando o board de fato declarou a
        // faceta e havia o que descrever.
        basis: ctx.deliveredCount > 0 ? [...basis, "entregues"] : basis,
        cohortSize: ctx.cohortSize,
        cohortAt: now,
      };
      // `rank` é DERIVADO do wsjf e gravado como cache: gate-core.js e suggest-work leem YAML cru e
      // não têm como calcular a razão. A invariante rank === wsjfTier(wsjfRatio(wsjf)) é testada.
      const rank = wsjfTier(wsjfRatio(wsjf));
      if (rank == null) continue;
      const pc: PriorityCall = {
        rank,
        rationale: item.rationale,
        ...(item.riskiestAssumption ? { riskiestAssumption: item.riskiestAssumption } : {}),
        source: "agent",
        assessedAt: now,
        wsjf,
      };
      // Releitura defensiva sob o lock: se o operador fixou um tier enquanto o modelo pensava, o
      // veto dele vence e o agente não pisa por cima.
      const updated = await updateCardOnDisk(input.boardId, item.id, (fresh) =>
        fresh.priorityCall?.source === "human" ? fresh : { ...fresh, priorityCall: pc },
      );
      if (updated) scored++;
    }

    revalidateBoard(input.boardId);
    return { ok: true, data: { scored, missing, skippedHuman, total: targets.length } };
  } catch (e) {
    return fail(e);
  }
}

/** Reavaliar TODOS de uma vez: o agente ranqueia o conjunto (ideias OU stories) num passe. */
export async function reorderPrioritiesAction(input: {
  boardId: string;
  kind: "idea" | "story";
}): Promise<Result<{ count: number }>> {
  await requireSession("reorderPrioritiesAction");
  try {
    const [config, cards] = await Promise.all([readBoardConfig(input.boardId), readCards(input.boardId)]);
    const strategy = await boardStrategy(input.boardId, config);
    const cohort =
      input.kind === "idea"
        ? cards.filter((c) => c.type === "idea")
        : cards.filter((c) => c.type === "story" && c.status != null);
    if (cohort.length === 0) return { ok: false, error: "Nada para ranquear ainda." };
    const prompt = buildPriorityReorderPrompt({ strategy, cards: cohort });
    const raw = await runClaudeJson(prompt, {
      timeoutMs: 300_000,
      context: { label: "Prioridade · reordenar tudo", board: input.boardId },
    });
    const batch = parsePriorityBatch(raw);
    if (!batch) return { ok: false, error: "O agente não retornou um ranqueamento válido." };
    const known = new Set(cohort.map((c) => c.id));
    const ts = new Date().toISOString();
    let count = 0;
    for (const item of batch) {
      if (!known.has(item.id)) continue; // guarda: só cards do conjunto
      const pc: PriorityCall = {
        rank: item.rank,
        rationale: item.rationale,
        ...(item.riskiestAssumption ? { riskiestAssumption: item.riskiestAssumption } : {}),
        source: "agent",
        assessedAt: ts,
      };
      const updated = await persistPriorityCall(input.boardId, item.id, pc);
      if (updated) count++;
    }
    revalidateBoard(input.boardId);
    return { ok: true, data: { count } };
  } catch (e) {
    return fail(e);
  }
}
