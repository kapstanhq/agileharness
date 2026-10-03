// O «DESFAZER» de uma decisão que o sistema tomou em nome do dono (política só-negócio) — núcleo DI da ação de servidor
// `undoSystemDecisionAction` (as deps de produção moram na ação). O modelo, as pré-condições e o que cada desfazer faz
// no card são puros (system-decisions.ts); aqui é a ordem das coisas:
//   1. acha a decisão no ledger (deste board; nunca uma entrada de desfazer) e vê se alguém já a desfez;
//   2. confere a pré-condição no card FRESCO, SOB o lock — um card que andou depois da decisão não é atropelado;
//   3. aplica (no card, na lixeira, ou abrindo o card de reversão da publicação);
//   4. registra o próprio desfazer no ledger (agente `human`, `undoOf`), e a transição quando o status mudou.

import { makeDraftCard } from "@/lib/storymap/draft";
import { applyUndoToCard, undoRefusal, type SystemDecision, type UndoHandle } from "@/lib/storymap/system-decisions";
import type { BoardConfig, Card } from "@/lib/storymap/types";
import { newSystemDecisionId } from "./decision-log";

export interface DecisionUndoDeps {
  readDecisions(board: string): Promise<SystemDecision[]>;
  readBoardConfig(board: string): Promise<BoardConfig>;
  readCard(board: string, cardId: string): Promise<Card | null>;
  /** o escritor único: `fn` recebe o card FRESCO sob o lock; null = não escreve. */
  updateCard(board: string, cardId: string, fn: (fresh: Card) => Card | null): Promise<Card | null>;
  restoreTrash(board: string, kind: "card" | "persona" | "system", id: string): Promise<{ ok: true } | { ok: false; error: string }>;
  createCard(board: string, card: Card): Promise<Card | null>;
  appendDecision(e: SystemDecision): Promise<void>;
  appendTransition?(t: { board: string; cardId: string; from: string | null; to: string; actor: "human"; note: string }): Promise<void>;
  /** depois de uma mudança de status: a cascata, a fila do train (best-effort). */
  afterStatusChange?(board: string, cardId: string): Promise<void>;
  /** WP5-F2 — reabre o condutor de um card estacionado: o card entra na FRENTE da fila (admissão de retomada + pump). */
  resumeConductor?(board: string, cardId: string): Promise<void>;
  now?(): number;
}

export type UndoResult = { ok: true; createdCardId?: string } | { ok: false; error: string };

/**
 * O card de REVERSÃO de uma publicação: técnico, na Triagem (o juiz o aceita), servindo a mesma história, com o sha de
 * volta, o motivo do dono e o COMO (reverter na main os commits deste card e publicar pelo pipeline — o canário prova
 * o sha no ar). Não é um re-deploy cego de um sha velho: isso derrubaria o trabalho dos outros cards publicados depois.
 * PURA.
 */
export function buildRevertPublishCard(
  card: Card,
  u: Extract<UndoHandle, { kind: "republish-previous" }>,
  config: Pick<BoardConfig, "statuses">,
  opts: { note?: string | null },
): Card {
  const staging = config.statuses.find((s) => s.staging)?.id ?? null;
  const serves = card.storyType == null || card.storyType === "user" ? card.id : (card.serves ?? card.parent ?? undefined);
  const draft = makeDraftCard({ type: "story", title: `Desfazer a publicação de «${card.title}»`, status: staging, cards: [] });
  return {
    ...draft,
    storyType: "technical",
    ...(serves ? { serves } : {}),
    links: [{ rel: "relates-to", to: card.id }],
    labels: ["desfazer-publicacao"],
    body: [
      "## Reverter a publicação (pedido do dono)",
      "",
      `- Card publicado: ${card.id} — ${card.title}`,
      `- Publicado: ${u.sha}`,
      `- Voltar a: ${u.previousSha}`,
      ...(opts.note?.trim() ? [`- Motivo do dono: ${opts.note.trim()}`] : []),
      `- Como: reverter na main os commits deste card${card.commitRange ? ` (${card.commitRange.base}..${card.commitRange.head})` : ""} e publicar pelo`,
      "  pipeline; o canário prova o sha no ar. Nunca republicar um sha velho às cegas — isso derrubaria o trabalho",
      "  dos cards publicados depois.",
    ].join("\n"),
  };
}

/** Desfaz a decisão `decisionId` do board. Nunca lança — toda recusa volta com o motivo em português. */
export async function undoSystemDecision(deps: DecisionUndoDeps, input: { board: string; decisionId: string; note?: string | null }): Promise<UndoResult> {
  try {
    const entries = await deps.readDecisions(input.board);
    const entry = entries.find((e) => e.id === input.decisionId && e.board === input.board && e.kind !== "undo");
    if (!entry) return { ok: false, error: `decisão não encontrada neste board: ${input.decisionId}` };
    const undone = entries.some((e) => e.kind === "undo" && e.undoOf === entry.id);
    const config = await deps.readBoardConfig(input.board);
    const u = entry.undo;
    const nowMs = (deps.now ?? Date.now)();
    const today = new Date(nowMs).toISOString().slice(0, 10);
    const record = (cardId: string | undefined, what: string) =>
      deps.appendDecision({
        v: 1,
        id: newSystemDecisionId(),
        at: new Date(nowMs).toISOString(),
        board: input.board,
        ...(cardId ? { cardId } : {}),
        agent: "human",
        kind: "undo",
        what,
        why: input.note?.trim() || "desfeito pelo dono",
        undoOf: entry.id,
      });

    if (!u || u.kind === "restore-trash") {
      const refused = undoRefusal(entry, { config, undone });
      if (refused || !u) return { ok: false, error: refused ?? "esta decisão não tem como desfazer" };
      const r = await deps.restoreTrash(input.board, u.trashKind, u.id);
      if (!r.ok) return r;
      await record(entry.cardId, `Desfez: ${entry.what}`);
      return { ok: true };
    }

    const card = await deps.readCard(input.board, u.cardId);
    const early = undoRefusal(entry, { config, card, undone, note: input.note });
    if (early) return { ok: false, error: early };

    if (u.kind === "resume-conductor") {
      if (!deps.resumeConductor) return { ok: false, error: "esta instalação não sabe reabrir o condutor" };
      await deps.resumeConductor(input.board, u.cardId);
      await record(u.cardId, `Desfez: ${entry.what} — o card voltou para a frente da fila do condutor`);
      return { ok: true };
    }

    if (u.kind === "republish-previous") {
      const created = await deps.createCard(input.board, buildRevertPublishCard(card!, u, config, { note: input.note }));
      if (!created) return { ok: false, error: "não consegui abrir o card de reversão da publicação" };
      await record(created.id, `Desfez: ${entry.what} — card de reversão ${created.id}`);
      return { ok: true, createdCardId: created.id };
    }

    let refused: string | null = null;
    let from: string | null = null;
    const written = await deps.updateCard(input.board, u.cardId, (fresh) => {
      refused = undoRefusal(entry, { config, card: fresh, undone, note: input.note });
      if (refused) return null;
      from = fresh.status ?? null;
      return applyUndoToCard(u, fresh, config, { today, note: input.note });
    });
    if (refused) return { ok: false, error: refused };
    if (!written) return { ok: false, error: `o card ${u.cardId} não existe mais neste board` };
    if (written.status && written.status !== from) {
      await deps.appendTransition?.({ board: input.board, cardId: u.cardId, from, to: written.status, actor: "human", note: `undo:${u.kind}` }).catch(() => {});
      await deps.afterStatusChange?.(input.board, u.cardId).catch(() => {});
    }
    await record(u.cardId, `Desfez: ${entry.what}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
