// O LOTE DO CONDUTOR — as operações (fase 7, decisões 5, 6 e 9 do dono). Núcleo DI; a produção mora em
// conductor-batch-deps.ts e a superfície MCP em mcp/dev-tools.ts (`claim_batch`, `batch_drop`).
//
//   • claimBatch      — a sessão do LÍDER (correção/manutenção) pega itens da MESMA funcionalidade que esperam na fila:
//                       todos ou nenhum. Valida ({@link validateBatch}), pega os claims de implementação como
//                       `session:<agentId>` (soltando os já pegos se um falhar), tira os itens da fila, carimba a marca
//                       do lote no líder e nos itens e grava o lote na sessão.
//   • dropBatchItem   — um item que falhou SAI do lote: solta o claim, apaga a marca, deixa um achado com o motivo e volta
//                       à fila SOZINHO (`solo` — nunca entra em outro lote), com o driver do condutor.
//   • releaseBatchItems — o LÍDER saiu (lixeira, adiado, sem driver): os itens abertos voltam à fila normal.
//   • splitBatch      — o train devolveu um lote sem dar para atribuir a um item: os itens voltam à fila sozinhos.
//
// As duas tools rodam DENTRO da trava do despacho (conductor.ts `withConductorDispatchLock`): a passada do pump grava a
// sua cópia da fila no fim (`persist(keep)`), e uma mudança da fila feita fora da trava seria apagada por ela.

import { isConducted, resolveConductorPolicy } from "@/lib/storymap/driver";
import type { FeatureKey } from "@/lib/storymap/feature-key";
import type { BoardConfig, Card, CardBatchMark, Finding } from "@/lib/storymap/types";
import { CLAIM_TTL_SESSION_MS, isClaimLive, sessionClaimActor } from "./claims";
import { batchIdFor, batchMark, batchRefusalText, validateBatch, type BatchRefusal } from "./conductor-batch";
import type { ConductorQueueEntry, ConductorQueueStore } from "./conductor";
import { claimForRole } from "./session-spawn";
import type { SessionClaimDeps } from "./session-claims";
import { sessionCardIds, type AgentSession, type SessionBatch } from "./session-worktree";

/** O achado que fica no item que saiu do lote (o motivo, como dado). */
export const BATCH_DROPPED_FINDING_ID = "batch-dropped";
/** A classe da espera do item que saiu do lote (volta à fila sozinho). */
export const BATCH_DROPPED_WAIT_KIND = "batch-dropped";

export interface BatchOpsDeps {
  sessions(): Promise<AgentSession[]>;
  readCard(board: string, cardId: string): Promise<Card | null>;
  readBoardConfig(board: string): Promise<BoardConfig | null>;
  /** a funcionalidade do card (feature-key.ts `featureKeyOf`, com o contexto do board). */
  featureKeyOf(board: string, card: Card): Promise<FeatureKey>;
  queue: ConductorQueueStore;
  /** roda `fn` sob a trava do despacho (conductor.ts `withConductorDispatchLock`). */
  withDispatchLock<T>(fn: () => Promise<T>): Promise<T>;
  claims: SessionClaimDeps["claims"];
  /** o recorte do board admite o card (board-pace.ts `gateAdmitsCard` com o portão do board). */
  admittedByScope(board: string, config: BoardConfig | null, card: Card): boolean;
  /** o teto do board por card (`autorun.cardBudgetUSD`); null = desligado. */
  settingsCapUSD(): number | null;
  /** o gasto já registrado do card (ledger). */
  ledgerUSD(board: string, cardId: string): Promise<number>;
  /** o custo da sessão até agora (a estimativa do transcript). */
  sessionCostUSD(s: AgentSession): Promise<number>;
  /** grava (ou apaga, com null) a marca do lote no card sob a trava do card; com `finding`, faz o upsert dele junto. */
  writeBatchMark(board: string, cardId: string, mark: CardBatchMark | null, finding?: Finding): Promise<void>;
  /** grava o lote na linha da sessão (undefined = a sessão volta a ser de um card só); lança quando não gravou. */
  setSessionBatch(sessionId: string, batch: SessionBatch | undefined): Promise<void>;
  now?(): number;
  log?(line: string): void;
}

export type ClaimBatchResult =
  | { ok: true; batchId: string; lead: string; cardIds: string[]; capUSD: number | null; warnings: string[] }
  | { ok: false; reason: string; refusals?: BatchRefusal[] };

export type DropBatchItemResult = { ok: true; detail: string } | { ok: false; reason: string };

const isoOf = (deps: Pick<BatchOpsDeps, "now">) => new Date((deps.now ?? Date.now)()).toISOString();
const logOf = (deps: Pick<BatchOpsDeps, "log">) => deps.log ?? ((l: string) => console.log(`[conductor-batch] ${l}`));
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * `claim_batch` — ver o cabeçalho. A sessão que chama tem de ser a dona do LÍDER (a linha dela no registro aponta o
 * card e ela segura o claim de implementação dele). Tudo ou nada: uma recusa da validação ou um claim que falha não
 * deixa nada pela metade.
 */
export async function claimBatch(deps: BatchOpsDeps, input: { sessionId: string; board: string; cardIds: readonly string[] }): Promise<ClaimBatchResult> {
  return deps.withDispatchLock(async () => {
    const { sessionId, board } = input;
    const s = (await deps.sessions()).find((x) => x.sessionId === sessionId);
    if (!s) return { ok: false, reason: `sessão ${sessionId} desconhecida (já descartada?)` };
    if (s.board !== board || !s.cardId) {
      return { ok: false, reason: `a sessão ${sessionId.slice(0, 8)} não segura um card líder no board ${board} — só o condutor do líder pega um lote` };
    }
    const lead = await deps.readCard(board, s.cardId);
    if (!lead) return { ok: false, reason: `o líder ${s.cardId} não foi encontrado` };
    if (!isConducted(lead)) return { ok: false, reason: `o líder ${lead.id} não está com o condutor (sem routing.driver: conductor)` };
    const now = (deps.now ?? Date.now)();
    const actor = sessionClaimActor(s.agentId);
    const claims = (await deps.claims.list(board)).filter((c) => isClaimLive(c, now));
    if (!claims.some((c) => c.cardId === lead.id && c.actor === actor && c.kind === "implement")) {
      return { ok: false, reason: `esta sessão não segura o claim de implementação do líder ${lead.id} (claim_card antes)` };
    }
    const config = await deps.readBoardConfig(board);
    const items: Card[] = [];
    for (const id of new Set(input.cardIds)) {
      if (id === lead.id) continue;
      const c = await deps.readCard(board, id);
      if (!c) return { ok: false, reason: `o item ${id} não foi encontrado no board ${board}` };
      items.push(c);
    }
    if (!items.length) return { ok: false, reason: "nenhum item além do líder — nada a pegar" };
    const dropped = new Set((s.batch?.dropped ?? []).map((d) => d.cardId));
    const existingIds = sessionCardIds(s).filter((id) => id !== lead.id);
    const existing: Card[] = [];
    for (const id of existingIds) {
      const c = await deps.readCard(board, id);
      if (c) existing.push(c);
    }
    const keys = new Map<string, FeatureKey>();
    for (const c of [lead, ...items]) keys.set(c.id, await deps.featureKeyOf(board, c));
    const ledger = new Map<string, number>();
    for (const c of [lead, ...existing, ...items]) ledger.set(c.id, await deps.ledgerUSD(board, c.id).catch(() => 0));
    const queue = await deps.queue.load();
    // Fechado: o plano DESTA sessão já foi submetido; ou o líder tem um plano congelado (de um lote anterior dele) e o
    // pedido traz item que não era daquele lote — o dono aprovou o lote de antes, não um maior.
    const frozen = !!lead.batch?.planHash && lead.batch.lead === lead.id;
    const closed = !!s.batch?.closed || (frozen && items.some((i) => i.batch?.lead !== lead.id));
    const verdict = validateBatch(lead, items, {
      board,
      boardOf: (id) => (items.some((i) => i.id === id) ? board : undefined),
      featureKeyOf: (c) => keys.get(c.id) as FeatureKey,
      queue,
      fromStatus: resolveConductorPolicy(config)?.fromStatuses ?? null,
      admittedByScope: (c) => deps.admittedByScope(board, config, c),
      droppedBySession: dropped,
      foreignClaimHolder: (id) => claims.find((c) => c.cardId === id && c.actor !== actor)?.actor ?? null,
      settingsCapUSD: deps.settingsCapUSD(),
      ledgerUSD: (id) => ledger.get(id) ?? 0,
      sessionCostUSD: await deps.sessionCostUSD(s).catch(() => 0),
      closed,
      existingItems: existing,
    });
    if (!verdict.ok) return { ok: false, reason: `lote recusado — ${batchRefusalText(verdict.refusals)}`, refusals: verdict.refusals };

    // os claims: todos ou nenhum
    const spec = claimForRole("implement");
    const acquired: string[] = [];
    for (const id of verdict.cardIds) {
      const res = await deps.claims
        .acquire({ board, cardId: id, actor, ...spec, ttlMs: CLAIM_TTL_SESSION_MS, note: `lote do condutor (líder ${lead.id})` })
        .catch((err): { ok: false; error: string } => ({ ok: false, error: errText(err) }));
      if (!res.ok) {
        for (const got of acquired) await deps.claims.release(board, got, actor).catch(() => {});
        const who = "holder" in res ? res.holder.actor : `erro: ${(res as { error: string }).error}`;
        return { ok: false, reason: `o claim de ${id} falhou (${who}) — nenhum item foi pego` };
      }
      acquired.push(id);
    }
    const releaseAcquired = async () => {
      for (const got of acquired) await deps.claims.release(board, got, actor).catch(() => {});
    };

    // o lote na SESSÃO primeiro: é ela que renova os claims dos itens e responde por eles. Se não gravar, nada fica pela
    // metade (os claims voltam, a fila fica como estava) — sem isso os claims caducavam e os itens ficavam sem dono.
    const prevBatch = s.batch;
    const batchId = prevBatch?.id ?? batchIdFor(s.sessionId);
    const leadKey = keys.get(lead.id) as FeatureKey;
    const batch: SessionBatch = {
      id: batchId,
      featureKey: leadKey.id,
      cardIds: [...existingIds.filter((id) => !dropped.has(id)), ...verdict.cardIds],
      dropped: s.batch?.dropped ?? [],
      ...(s.batch?.closed ? { closed: true as const } : {}),
    };
    try {
      await deps.setSessionBatch(s.sessionId, batch);
    } catch (err) {
      await releaseAcquired();
      return { ok: false, reason: `o lote não foi gravado na sessão (${errText(err)}) — nenhum item foi pego` };
    }
    // fora da fila (os itens agora são desta sessão); se a fila não gravar, desfaz a sessão e os claims
    const taken = new Set(verdict.cardIds);
    const kept = queue.filter((e) => !(e.board === board && taken.has(e.cardId)));
    if (kept.length !== queue.length) {
      try {
        await deps.queue.persist(kept);
      } catch (err) {
        await deps.setSessionBatch(s.sessionId, prevBatch).catch(() => {});
        await releaseAcquired();
        return { ok: false, reason: `a fila do condutor não foi gravada (${errText(err)}) — nenhum item foi pego` };
      }
    }

    const planHash = frozen ? lead.batch?.planHash : undefined; // a retomada mantém o plano já aprovado
    const at = isoOf(deps);
    const warnings: string[] = [];
    for (const id of [lead.id, ...verdict.cardIds]) {
      if (id === lead.id && lead.batch?.id === batchId && lead.batch.sessionId === s.sessionId) continue;
      await deps
        .writeBatchMark(board, id, batchMark({ id: batchId, lead: lead.id, sessionId: s.sessionId, at, planHash }))
        .catch((err) => warnings.push(`a marca do lote não foi gravada em ${id} (${errText(err)})`));
    }
    logOf(deps)(`${board}/${lead.id}: lote ${batchId} pegou ${verdict.cardIds.join(", ")} (sessão ${s.sessionId.slice(0, 8)})`);
    return { ok: true, batchId, lead: lead.id, cardIds: [lead.id, ...batch.cardIds], capUSD: verdict.capUSD, warnings };
  });
}

/** A entrada da fila de um item que volta sozinho (ou a existente, promovida a `solo`). PURA. */
function soloEntry(existing: ConductorQueueEntry | undefined, board: string, cardId: string, reason: string, at: string, solo: boolean): ConductorQueueEntry {
  const base = existing ?? { board, cardId, queuedAt: at, attempts: 0 };
  return { ...base, ...(solo ? { solo: true as const } : {}), lastWaitReason: reason.slice(0, 300), lastWaitKind: BATCH_DROPPED_WAIT_KIND, lastWaitAt: at };
}

async function requeue(deps: Pick<BatchOpsDeps, "queue">, board: string, ids: readonly string[], reason: string, at: string, solo: boolean): Promise<void> {
  const entries = await deps.queue.load();
  const next = [...entries];
  for (const id of ids) {
    const i = next.findIndex((e) => e.board === board && e.cardId === id);
    if (i >= 0) next[i] = soloEntry(next[i], board, id, reason, at, solo);
    else next.push(soloEntry(undefined, board, id, reason, at, solo));
  }
  await deps.queue.persist(next);
}

/** O achado do item que saiu do lote. PURA. */
export function batchDroppedFinding(reason: string, today: string): Finding {
  return {
    id: BATCH_DROPPED_FINDING_ID,
    lens: "general",
    severity: "medium",
    title: "o item saiu do lote do condutor e volta à fila sozinho",
    detail: reason.slice(0, 2000),
    status: "open",
    statusBy: BATCH_DROPPED_FINDING_ID,
    statusAt: today,
  };
}

/**
 * `batch_drop` — ver o cabeçalho. O LÍDER não sai por aqui (sem ele o lote não tem plano nem aprovação): a sessão tira
 * os itens um a um e encerra.
 */
export async function dropBatchItem(deps: BatchOpsDeps, input: { sessionId: string; cardId: string; reason: string }): Promise<DropBatchItemResult> {
  const reason = input.reason.trim();
  if (!reason) return { ok: false, reason: "diga por que o item sai do lote (reason)" };
  return deps.withDispatchLock(async () => {
    const s = (await deps.sessions()).find((x) => x.sessionId === input.sessionId);
    if (!s) return { ok: false, reason: `sessão ${input.sessionId} desconhecida (já descartada?)` };
    if (!s.board || !s.cardId) return { ok: false, reason: "esta sessão não segura um lote" };
    if (input.cardId === s.cardId) {
      return { ok: false, reason: "o líder não sai do lote: tire cada item (batch_drop), devolva o líder (report_progress) e encerre a sessão" };
    }
    if (!s.batch || !sessionCardIds(s).includes(input.cardId)) return { ok: false, reason: `${input.cardId} não está no lote desta sessão` };
    const board = s.board;
    const at = isoOf(deps);
    const before = s.batch;
    // a SESSÃO primeiro: se a saída não for gravada nela, nada muda (o item segue no lote). Na ordem inversa, um item já
    // devolvido à fila seguiria contado como da sessão — ela nunca acabaria, e ele esperaria por ela.
    try {
      await deps.setSessionBatch(s.sessionId, { ...before, dropped: [...before.dropped, { cardId: input.cardId, reason: reason.slice(0, 300), at }] });
    } catch (err) {
      return { ok: false, reason: `a saída do item não foi gravada na sessão (${errText(err)}) — o item segue no lote; tente de novo` };
    }
    try {
      await requeue(deps, board, [input.cardId], `saiu do lote do condutor: ${reason}`, at, true);
    } catch (err) {
      await deps.setSessionBatch(s.sessionId, before).catch(() => {});
      return { ok: false, reason: `a fila do condutor não foi gravada (${errText(err)}) — o item segue no lote; tente de novo` };
    }
    const warnings: string[] = [];
    await deps
      .writeBatchMark(board, input.cardId, null, batchDroppedFinding(`Saiu do lote ${before.id} (líder ${s.cardId}): ${reason}`, at.slice(0, 10)))
      .catch((err) => warnings.push(` (a marca do lote não saiu do card: ${errText(err)})`));
    await deps.claims.release(board, input.cardId, sessionClaimActor(s.agentId)).catch(() => {});
    logOf(deps)(`${board}/${input.cardId}: saiu do lote ${before.id} — ${reason.slice(0, 160)}`);
    return { ok: true, detail: `${input.cardId} saiu do lote e voltou à fila do condutor sozinho; o claim foi solto${warnings.join("")}` };
  });
}

/**
 * O LÍDER do lote saiu: os itens ainda da sessão perdem a marca e o claim e voltam à fila NORMAL (podem entrar em outro
 * lote — não falharam). Chamado no fim da sessão (conductor.ts `endFinishedConductors`).
 */
export async function releaseBatchItems(deps: BatchOpsDeps, s: AgentSession, why: string): Promise<string[]> {
  if (!s.board || !s.cardId) return [];
  const board = s.board;
  const items = sessionCardIds(s).filter((id) => id !== s.cardId);
  if (!items.length) return [];
  return deps.withDispatchLock(async () => {
    const at = isoOf(deps);
    const open: string[] = [];
    for (const id of items) {
      const card = await deps.readCard(board, id).catch(() => null);
      if (!card || !isConducted(card)) continue;
      await deps.claims.release(board, id, sessionClaimActor(s.agentId)).catch(() => {});
      await deps.writeBatchMark(board, id, null).catch(() => {});
      open.push(id);
    }
    if (open.length) await requeue(deps, board, open, `o líder ${s.cardId} do lote saiu (${why}) — o item volta à fila`, at, false);
    return open;
  });
}

/**
 * A sessão do lote ACABOU (tudo entregue, ou o líder saiu): a marca DESTE lote sai do líder, dos itens e dos que saíram
 * (a de outro lote fica). A marca é de uma rodada: sem esta limpeza, um card reaberto pularia a parada do plano com a
 * aprovação antiga, e o teto e o gasto do lote seguiriam valendo. Chamado no fim da sessão (conductor.ts
 * `endFinishedConductors`). Devolve os cards limpos.
 */
export async function clearBatchMarks(deps: Pick<BatchOpsDeps, "readCard" | "writeBatchMark">, s: AgentSession): Promise<string[]> {
  if (!s.board || !s.cardId) return [];
  const batchId = s.batch?.id;
  const ids = [...new Set([s.cardId, ...(s.batch?.cardIds ?? []), ...(s.batch?.dropped ?? []).map((d) => d.cardId)])];
  const cleared: string[] = [];
  for (const id of ids) {
    const card = await deps.readCard(s.board, id).catch(() => null);
    const m = card?.batch;
    // DESTE lote: o id do lote da sessão, a sessão gravada na marca, ou o líder desta sessão (a retomada que seguiu só,
    // depois de uma divisão, não tem lote na sessão mas o líder guarda a marca do lote de antes)
    const ours = !!m && ((!!batchId && m.id === batchId) || m.sessionId === s.sessionId || (id === s.cardId && m.lead === s.cardId));
    if (!ours) continue;
    await deps.writeBatchMark(s.board, id, null);
    cleared.push(id);
  }
  return cleared;
}

/**
 * O train devolveu um LOTE e a devolução não é de um item só (ou foi a segunda do mesmo lote): o serviço DIVIDE — os
 * itens voltam à fila sozinhos (`solo`), sem a marca, com o veredito como motivo; o líder retoma só (conductor-handoff.ts).
 */
export async function splitBatch(
  deps: Pick<BatchOpsDeps, "queue" | "withDispatchLock" | "writeBatchMark" | "readCard" | "now" | "log">,
  input: { board: string; leadId: string; itemIds: readonly string[]; why: string },
): Promise<string[]> {
  return deps.withDispatchLock(async () => {
    const at = isoOf(deps);
    const back: string[] = [];
    for (const id of input.itemIds) {
      if (id === input.leadId) continue;
      const card = await deps.readCard(input.board, id).catch(() => null);
      if (!card || !isConducted(card)) continue;
      await deps.writeBatchMark(input.board, id, null, batchDroppedFinding(`O lote do líder ${input.leadId} foi dividido pelo serviço: ${input.why}`, at.slice(0, 10))).catch(() => {});
      back.push(id);
    }
    if (back.length) await requeue(deps, input.board, back, `o lote do líder ${input.leadId} foi dividido: ${input.why}`, at, true);
    logOf(deps)(`${input.board}/${input.leadId}: lote dividido — ${back.join(", ") || "nenhum item"} voltou à fila sozinho`);
    return back;
  });
}
