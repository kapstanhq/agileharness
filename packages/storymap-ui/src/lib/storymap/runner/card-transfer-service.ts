// MUDAR UM CARD DE BOARD — o IO. A regra (quando pode, o que o card vira) é card-transfer.ts; aqui:
//   • o que está trabalhando no card AGORA (run, reserva, sessão, fila de integração, publicação) é MEDIDO de novo no
//     servidor — a tela e a tool não decidem isso;
//   • a escrita acontece sob o lock por card dos DOIS boards (ordem fixa: nunca dois escritores se cruzam), relendo o
//     card FRESCO: grava no destino PRIMEIRO, leva os anexos (plano, telas, proposta, prints de refino/bug/remoção) e só
//     então apaga a origem — uma queda no meio deixa o card em dobro (visível, reparável), nunca sumido;
//   • depois: os vínculos de quem ficou no board antigo caem (não apontam para o vazio), o histórico de status e o custo
//     do card vão junto, a mudança vira um salto no ledger e uma decisão nos DOIS boards («Acompanhar»).
// O serviço é o único escritor de board-data no runtime: chamado pela action do operador e pela tool MCP.

import { promises as fs } from "node:fs";
import path from "node:path";
import { listBoards, readBoardConfig, readCards } from "@/lib/storymap/repo";
import { bugsDir, cardPath, cardsDir, planPath, proposalPath, refineDir, retireDir, wireframePath } from "@/lib/storymap/paths";
import { updateCardOnDisk, withCardLock, writeCardToPath } from "@/lib/storymap/write";
import { planCardTransfer, transferRefusal, transferRegimeLoosening, type TransferBusy, type TransferRegime } from "@/lib/storymap/card-transfer";
import { cardTransferEntries, type SystemDecision } from "@/lib/storymap/system-decisions";
import { anchoredTo } from "@/lib/storymap/card-dependents";
import type { BoardConfig, Card } from "@/lib/storymap/types";
import { appendTransition, rehomeCardTransitions, type TransitionActor } from "./transitions";
import { appendSystemDecision, newSystemDecisionId } from "./decision-log";

export interface CardTransferInput {
  fromBoard: string;
  toBoard: string;
  cardId: string;
  /** a âncora no board novo (passo para história de usuário; história/passo/atividade para entrega). */
  anchor?: string | null;
  reason?: string | null;
  /** quem pediu: `human` (a tela), `agent` (uma tool) ou `triage-judge` (o roteamento). */
  by: "human" | "agent" | "triage-judge";
}

export type CardTransferResult =
  | { ok: true; card: Card; fromStatus: string | null; toStatus: string | null; warnings: string[] }
  | { ok: false; error: string };

export interface CardTransferDeps {
  listBoards(): Promise<Array<{ id: string; name: string }>>;
  readBoardConfig(board: string): Promise<BoardConfig | null>;
  readCards(board: string): Promise<Card[]>;
  /** o que trabalha no card agora — medido aqui, no servidor. */
  busy(board: string, card: Card): Promise<TransferBusy>;
  /**
   * O regime do board para este card (autonomia, publicação, ritmo, escopo, matriz) — comparado na mudança de um agente
   * ou do juiz ({@link transferRegimeLoosening}). Ausente ⇒ o card mantém o passo (o comportamento de antes).
   */
  regime?(board: string, card: Card): Promise<TransferRegime>;
  /** a escrita sob os dois locks (ver {@link moveCardFiles}). */
  moveFiles(fromBoard: string, toBoard: string, cardId: string, mutate: (fresh: Card) => Card | null | Promise<Card | null>): Promise<Card | null>;
  /** tira os vínculos que outros cards do board antigo tinham com este — devolve quem mudou. */
  stripLinks(fromBoard: string, cardId: string): Promise<string[]>;
  /** o histórico de status e o custo do card vão para o board novo. */
  rehome(fromBoard: string, toBoard: string, cardId: string): Promise<void>;
  appendTransition(input: { board: string; cardId: string; from: string | null; to: string; actor: TransitionActor; note: string }): Promise<void>;
  record(entry: SystemDecision): Promise<void>;
  /** o versionamento e o aviso de Inbox (os dois boards). */
  after?(fromBoard: string, toBoard: string): void;
  now?(): number;
  log?(line: string): void;
}

const ACTOR: Record<CardTransferInput["by"], TransitionActor> = { human: "human", agent: "system", "triage-judge": "run:triage-judge" };

/** Muda o card de board. Nunca lança: recusa com o motivo, ou devolve o card como ficou. */
export async function transferCard(deps: CardTransferDeps, input: CardTransferInput): Promise<CardTransferResult> {
  const log = deps.log ?? ((l: string) => console.log(`[card-transfer] ${l}`));
  try {
    const boards = await deps.listBoards();
    const nameOf = (id: string) => boards.find((b) => b.id === id)?.name ?? id;
    if (!boards.some((b) => b.id === input.fromBoard)) return { ok: false, error: `o board «${input.fromBoard}» não existe` };
    const toConfig = boards.some((b) => b.id === input.toBoard) ? await deps.readBoardConfig(input.toBoard) : null;
    const [fromCards, toCards] = await Promise.all([deps.readCards(input.fromBoard), toConfig ? deps.readCards(input.toBoard) : Promise.resolve([] as Card[])]);
    const card = fromCards.find((c) => c.id === input.cardId) ?? null;
    const refusal = transferRefusal({
      fromBoard: input.fromBoard,
      toBoard: input.toBoard,
      card,
      toConfig,
      toHasCard: toCards.some((c) => c.id === input.cardId),
      busy: card ? await deps.busy(input.fromBoard, card) : {},
      dependents: fromCards.filter((c) => c.id !== input.cardId && anchoredTo(c, input.cardId)),
    });
    if (refusal || !card || !toConfig) return { ok: false, error: refusal ?? "o card não pode mudar de board" };

    const at = new Date((deps.now ?? Date.now)()).toISOString();
    // Um AGENTE (ou o juiz) não leva o card a um regime mais permissivo mantendo o passo: ele entra pela Triagem de lá.
    // O operador (a tela) decide — mantém o passo sempre.
    const forceEntry =
      input.by !== "human" && deps.regime
        ? transferRegimeLoosening(card, await deps.regime(input.fromBoard, card), await deps.regime(input.toBoard, card))
        : [];
    let planned: ReturnType<typeof planCardTransfer> | { error: string } | null = null;
    const written = await deps.moveFiles(input.fromBoard, input.toBoard, input.cardId, async (fresh) => {
      // MEDIDO DE NOVO sob os dois locks: um run, reserva ou sessão que começou entre a primeira medição e aqui não pode
      // ter o card movido por baixo dele.
      const again = transferRefusal({
        fromBoard: input.fromBoard,
        toBoard: input.toBoard,
        card: fresh,
        toConfig,
        toHasCard: false,
        busy: await deps.busy(input.fromBoard, fresh),
        dependents: [],
      });
      if (again) {
        planned = { error: again };
        return null;
      }
      planned = planCardTransfer({
        card: fresh,
        fromBoard: input.fromBoard,
        fromName: nameOf(input.fromBoard),
        toBoard: input.toBoard,
        toName: nameOf(input.toBoard),
        fromCards,
        toConfig,
        toCards,
        anchor: input.anchor ?? null,
        by: input.by,
        reason: input.reason ?? null,
        at,
        ...(forceEntry.length ? { forceEntry } : {}),
      });
      return planned.error ? null : planned.card;
    });
    const result = planned as ReturnType<typeof planCardTransfer> | { error: string } | null;
    if (result?.error) return { ok: false, error: result.error };
    const plan = result as ReturnType<typeof planCardTransfer> | null;
    if (!written || !plan) return { ok: false, error: "o card mudou enquanto a mudança era preparada — tente de novo" };

    // Depois da escrita, best-effort: o card já está no board novo; o que falhar aqui não o desfaz.
    const unlinked = await deps.stripLinks(input.fromBoard, input.cardId).catch(() => [] as string[]);
    await deps.rehome(input.fromBoard, input.toBoard, input.cardId).catch((err) => log(`histórico/custo não re-atribuídos: ${err instanceof Error ? err.message : String(err)}`));
    if (plan.toStatus) {
      await deps
        .appendTransition({
          board: input.toBoard,
          cardId: input.cardId,
          from: plan.fromStatus,
          to: plan.toStatus,
          actor: ACTOR[input.by],
          note: `transfer:${input.fromBoard}→${input.toBoard}`,
        })
        .catch(() => {});
    }
    const warnings = [...plan.warnings, ...(unlinked.length ? [`${unlinked.length} card(s) do board antigo tinham vínculo com este — os vínculos caíram`] : [])];
    const [fromEntry, toEntry] = cardTransferEntries(
      {
        fromBoard: input.fromBoard,
        fromName: nameOf(input.fromBoard),
        toBoard: input.toBoard,
        toName: nameOf(input.toBoard),
        cardId: input.cardId,
        title: written.title,
        agent: input.by,
        reason: input.reason ?? null,
        warnings,
      },
      { at, idOf: () => newSystemDecisionId() },
    );
    await deps.record(fromEntry).catch(() => {});
    await deps.record(toEntry).catch(() => {});
    deps.after?.(input.fromBoard, input.toBoard);
    log(`${input.fromBoard}/${input.cardId} → ${input.toBoard} (${plan.fromStatus ?? "—"} → ${plan.toStatus ?? "—"}) por ${input.by}`);
    return { ok: true, card: written, fromStatus: plan.fromStatus, toStatus: plan.toStatus, warnings };
  } catch (err) {
    return { ok: false, error: `a mudança de board falhou: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Os anexos de um card (os que existirem) — arquivo ou diretório por card, todos sob o board. */
function sidecarsOf(board: string, cardId: string): string[] {
  return [planPath(board, cardId), wireframePath(board, cardId), proposalPath(board, cardId), refineDir(board, cardId), bugsDir(board, cardId), retireDir(board, cardId)];
}

async function exists(p: string): Promise<boolean> {
  return fs
    .access(p)
    .then(() => true)
    .catch(() => false);
}

/**
 * A escrita da mudança, sob o lock por card dos DOIS boards (sempre na mesma ordem: nenhum par de mudanças se cruza).
 * Relê o card FRESCO da origem, aplica `mutate`, grava no destino, leva os anexos e só então apaga a origem.
 */
export async function moveCardFiles(
  fromBoard: string,
  toBoard: string,
  cardId: string,
  mutate: (fresh: Card) => Card | null | Promise<Card | null>,
): Promise<Card | null> {
  const [first, second] = [fromBoard, toBoard].sort();
  return withCardLock(first, cardId, () =>
    withCardLock(second, cardId, async () => {
      const fresh = (await readCards(fromBoard)).find((c) => c.id === cardId);
      if (!fresh) return null;
      const next = await mutate(fresh);
      if (!next) return null;
      const dest = cardPath(toBoard, cardId);
      if (await exists(dest)) throw new Error(`já existe um card «${cardId}» no board «${toBoard}»`);
      await fs.mkdir(cardsDir(toBoard), { recursive: true });
      await writeCardToPath(dest, { ...next, id: cardId });
      const from = sidecarsOf(fromBoard, cardId);
      const to = sidecarsOf(toBoard, cardId);
      for (let i = 0; i < from.length; i++) {
        if (!(await exists(from[i])) || (await exists(to[i]))) continue;
        await fs.mkdir(path.dirname(to[i]), { recursive: true });
        await fs.rename(from[i], to[i]);
      }
      await fs.rm(cardPath(fromBoard, cardId), { force: true });
      return { ...next, id: cardId };
    }),
  );
}

/** Tira de cada card do board antigo os vínculos com o card que saiu (sob o lock de cada um). */
export async function stripLinksTo(board: string, cardId: string): Promise<string[]> {
  const changed: string[] = [];
  for (const c of await readCards(board)) {
    if (!c.links.some((l) => l.to === cardId)) continue;
    // Um vizinho que a escrita recusa (um card legado fora da hierarquia) fica com o vínculo pendurado — os outros seguem.
    try {
      const w = await updateCardOnDisk(board, c.id, (fresh) =>
        fresh.links.some((l) => l.to === cardId) ? { ...fresh, links: fresh.links.filter((l) => l.to !== cardId) } : null,
      );
      if (w) changed.push(c.id);
    } catch (err) {
      console.warn(`[card-transfer] o vínculo de ${board}/${c.id} com ${cardId} não pôde ser tirado: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return changed;
}

/** O que trabalha no card agora, medido nas fontes de verdade do serviço (cada uma tolerante: sem a fonte, não ocupado). */
export async function measureTransferBusy(board: string, card: Card): Promise<TransferBusy> {
  const busy: TransferBusy = {};
  try {
    const { getCardClaims } = await import("./claims");
    busy.claim = (await getCardClaims().claimedCardIds(board)).has(card.id);
  } catch {
    /* sem o registro de reservas */
  }
  try {
    const { getRunnerEngine } = await import("./engine");
    busy.run = getRunnerEngine().isInFlight(board, card.id);
  } catch {
    /* sem o engine (boot, testes) */
  }
  try {
    const { allSessions } = await import("./session-worktree");
    busy.session = (await allSessions()).some((s) => s.board === board && s.cardId === card.id);
  } catch {
    /* sem o registro de sessões */
  }
  try {
    const [{ getMergeQueue }, { isLiveMergeStatus }] = await Promise.all([import("./merge-queue"), import("./merge-status")]);
    busy.mergeQueue = getMergeQueue()
      .getSnapshot()
      .entries.some((e) => e.board === board && e.cardId === card.id && isLiveMergeStatus(e.status));
  } catch {
    /* sem a fila */
  }
  // Uma publicação disparada e ainda não assentada: o settle procura o card neste board.
  busy.publishing = card.deployFiredAt != null;
  return busy;
}

/** O regime de um board para um card, medido nas fontes do serviço (config, ritmo e escopo em vigor). */
export async function measureTransferRegime(board: string, card: Card): Promise<TransferRegime> {
  const config = await readBoardConfig(board).catch(() => null);
  const { boardGateNow } = await import("./board-pace-store");
  const { gateAdmitsCard } = await import("./board-pace");
  const gate = boardGateNow(board, config);
  return {
    // config ilegível ⇒ o regime mais ESTRITO (modo humano, publicação manual, matriz padrão): nunca afrouxa por erro
    config: config ?? { autonomy: { mode: "human" } as BoardConfig["autonomy"] },
    pace: gate.level,
    admits: gateAdmitsCard(gate, card).admit,
  };
}

/** As deps de produção. */
export function defaultCardTransferDeps(): CardTransferDeps {
  return {
    listBoards: async () => (await listBoards()).map((b) => ({ id: b.id, name: b.name })),
    regime: measureTransferRegime,
    readBoardConfig: (board) => readBoardConfig(board).catch(() => null),
    readCards: (board) => readCards(board),
    busy: measureTransferBusy,
    moveFiles: moveCardFiles,
    stripLinks: stripLinksTo,
    rehome: async (fromBoard, toBoard, cardId) => {
      await rehomeCardTransitions(fromBoard, cardId, toBoard);
      const { getTelemetryStore } = await import("./telemetry");
      await getTelemetryStore().reassignCard(fromBoard, cardId, toBoard);
    },
    appendTransition: (input) => appendTransition(input),
    record: (entry) => appendSystemDecision(entry),
    after: (fromBoard, toBoard) => {
      void import("./board-data-flush").then((m) => m.scheduleBoardDataFlush()).catch(() => {});
      void import("@/lib/notifications/server/inbox-bus")
        .then((m) => {
          m.signalInboxChanged(fromBoard, "card");
          m.signalInboxChanged(toBoard, "card");
        })
        .catch(() => {});
    },
  };
}
