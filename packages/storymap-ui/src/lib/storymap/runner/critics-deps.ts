// OS CRÍTICOS LANÇADOS PELO SERVIÇO (critics.ts) ligados à produção. Resolvido por chamada (o settings é lido vivo).
//   • o LEDGER e a FILA moram em `.runner/` (gitignored), como os do auditor técnico;
//   • o run é o de contexto limpo de critics-spawn.ts, com o binário do settings;
//   • a mudança é lida do checkout do alvo só por git (technical-audit-deps.ts `materialize`);
//   • o aviso ao condutor é a MESMA entrega das respostas (conductor-pause-deps.ts `wakeConductorNow`): o pane vivo
//     recebe a linha fixa; sem condutor vivo e sem pergunta aberta, o card estacionado volta para a frente da fila;
//   • o serviço move a entrega aprovada com o papel `critic` (mcp/actor.ts) — nunca como o dono — e respeitando a
//     decisão do dono aberta (owner-waiting.ts `ownerPublishHold`), a mesma régua do `move_card` de um agente.

import { promises as fsp } from "node:fs";
import path from "node:path";
import { runnerStateDir } from "@/lib/storymap/paths";
import { listBoards, readBoardConfig, readCard, readCards } from "@/lib/storymap/repo";
import { readPlan } from "@/lib/storymap/sidecars";
import { updateCardOnDisk } from "@/lib/storymap/write";
import { atomicWriteFile } from "@/lib/storymap/atomic-write";
import { deliveryProofOf } from "@/lib/storymap/delivery-audit";
import { ownerPublishHold } from "@/lib/storymap/owner-waiting";
import { runAsService, runWithMcpActor, type McpActor } from "@/lib/storymap/mcp/actor";
import type { BoardConfig, Card } from "@/lib/storymap/types";
import { resolvedClaudeBin } from "./claude-bin";
import { loadRunnerConfig } from "./config";
import { appendSystemDecision } from "./decision-log";
import { automationAdmission } from "./proxy-deps";
import { boardGateNow } from "./board-pace-store";
import { isOrganizeOnly } from "@/lib/storymap/organize-only-core";
import { materialize } from "./technical-audit-deps";
import { spawnCritic } from "./critics-spawn";
import { isConducted } from "@/lib/storymap/driver";
import {
  DELIVERY_VERIFIED_LINE,
  deliveryGateVerdict,
  guardrailCandidates,
  isBatchLead,
  isBuildStep,
  planGateVerdict,
  planSubjectFor,
  startCritic,
  sweepCritics,
  verifiedDelivery,
  type CriticDeps,
  type CriticLedgerStore,
  type CriticPending,
  type CriticQueueStore,
  type CriticRecord,
} from "./critics";

export function criticsLedgerPath(): string {
  return path.join(runnerStateDir(), "critics-ledger.json");
}
export function criticsPendingPath(): string {
  return path.join(runnerStateDir(), "critics-pending.json");
}

async function readJsonList<T>(file: string, key: string, keep: (x: unknown) => x is T): Promise<T[]> {
  try {
    const parsed = JSON.parse(await fsp.readFile(file, "utf8")) as Record<string, unknown>;
    const list = parsed?.[key];
    return Array.isArray(list) ? list.filter(keep) : [];
  } catch {
    return [];
  }
}
async function writeJsonList(file: string, key: string, list: unknown[]): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await atomicWriteFile(file, JSON.stringify({ v: 1, [key]: list }, null, 2));
}

const isRow = (x: unknown): x is CriticRecord => !!x && typeof x === "object" && typeof (x as CriticRecord).key === "string" && typeof (x as CriticRecord).board === "string";
const isPending = (x: unknown): x is CriticPending =>
  !!x && typeof x === "object" && typeof (x as CriticPending).board === "string" && typeof (x as CriticPending).cardId === "string" && ["plan", "diff", "delivery"].includes((x as CriticPending).kind);

/** O ledger dos críticos em disco. Ilegível = vazio (fail-closed: sem registro, nada está aprovado). */
export function diskCriticLedger(file: string = criticsLedgerPath()): CriticLedgerStore {
  return { load: () => readJsonList(file, "rows", isRow), persist: (rows) => writeJsonList(file, "rows", rows) };
}
export function diskCriticQueue(file: string = criticsPendingPath()): CriticQueueStore {
  return { load: () => readJsonList(file, "pending", isPending), save: (list) => writeJsonList(file, "pending", list) };
}

/** O papel do serviço quando ele move a entrega que o verificador aprovou: `critic`, nunca o dono (mcp/actor.ts). */
const CRITIC_ACTOR = { level: "write", resolvedRole: "critic" } as McpActor;

/** A entrega aprovada vai ao passo que o agente pediu — pela MESMA ação de mover, com o papel `critic`. */
async function advanceDelivery(board: string, cardId: string, to: string): Promise<{ ok: boolean; error?: string }> {
  const [card, cfg] = await Promise.all([readCard(board, cardId), readBoardConfig(board)]);
  if (!card) return { ok: false, error: "o card não existe mais" };
  const hold = ownerPublishHold(card, cfg.statuses.find((s) => s.id === card.status), cfg.statuses.find((s) => s.id === to), cfg);
  if (hold) return { ok: false, error: hold };
  const { moveCardAction } = await import("@/app/actions");
  const r = await runWithMcpActor(CRITIC_ACTOR, () => moveCardAction({ boardId: board, cardId, status: to }));
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

export function defaultCriticDeps(): CriticDeps {
  return {
    ledger: diskCriticLedger(),
    masterEnabled: () => loadRunnerConfig().autorun.enabled,
    boardGate: boardGateNow,
    admission: automationAdmission,
    readCard: (board, cardId) => readCard(board, cardId).catch(() => null),
    readBoardConfig: (board) => readBoardConfig(board).catch(() => null),
    readPlan: (board, cardId) => readPlan(board, cardId).catch(() => null),
    contextPack: async (board, cardId) => {
      const { loadContextPack } = await import("@/lib/storymap/context-pack");
      return (await loadContextPack(board, cardId))?.text ?? null;
    },
    materialize,
    review: async (req) => {
      let claudeBin: string;
      try {
        claudeBin = resolvedClaudeBin({ name: loadRunnerConfig().autorun.claudeBin });
      } catch (err) {
        return { runId: "none", model: req.model, error: `binário claude indisponível: ${err instanceof Error ? err.message : String(err)}` };
      }
      return spawnCritic(req, { claudeBin });
    },
    updateCard: (board, cardId, fn) => updateCardOnDisk(board, cardId, fn),
    notifyConductor: async (board, cardId, line) => {
      // A entrega aprovada já foi levada adiante pelo serviço: só a sessão VIVA fica sabendo — reabrir um condutor
      // estacionado para isso gastaria uma sessão sem trabalho. Os outros vereditos acordam (ou retomam) o condutor.
      if (line === DELIVERY_VERIFIED_LINE) {
        const { noticeLiveConductorNow } = await import("./card-intents-deps");
        return noticeLiveConductorNow(board, cardId, line);
      }
      const { wakeConductorNow } = await import("./conductor-pause-deps");
      return wakeConductorNow(board, cardId, [], "system", line);
    },
    advance: advanceDelivery,
    record: appendSystemDecision,
    batchItems: (board, lead) => batchItemsOf(board, lead),
    closeSessionBatch: async (sessionId) => {
      const { closeSessionBatchNow } = await import("./conductor-batch-deps");
      await closeSessionBatchNow(sessionId);
    },
  };
}

/** Os ITENS do lote de que `lead` é o líder: os cards do board com a mesma marca de lote (sem o líder). */
async function batchItemsOf(board: string, lead: Card): Promise<Card[]> {
  const id = lead.batch?.id;
  if (!id) return [];
  return (await readCards(board).catch(() => [] as Card[])).filter((c) => c.id !== lead.id && c.batch?.id === id && c.batch.lead === lead.id);
}

const proof = (body: string | undefined) => deliveryProofOf(body);

/** Fire-and-forget do chamador. O crítico roda como SERVIÇO: nunca herda o ator MCP de quem pediu (mcp/actor.ts). */
function launch(p: CriticPending): Promise<unknown> {
  return runAsService(() => startCritic(defaultCriticDeps(), diskCriticQueue(), p, proof));
}

export function startPlanCriticNow(board: string, cardId: string): Promise<unknown> {
  return launch({ kind: "plan", board, cardId, at: new Date().toISOString() });
}
export function startDeliveryVerifierNow(board: string, cardId: string, to: string): Promise<unknown> {
  return launch({ kind: "delivery", board, cardId, to, at: new Date().toISOString() });
}
export function startDiffReviewNow(board: string, cardId: string, questionId: string): Promise<unknown> {
  return launch({ kind: "diff", board, cardId, questionId, at: new Date().toISOString() });
}

/**
 * A régua do `move_card` de um AGENTE (o handler do MCP a chama antes de mover): o plano aprovado antes de construir e
 * o verificador antes de integrar uma entrega autônoma. Devolve o motivo da recusa (e chama o crítico que falta, em
 * segundo plano), ou null. O dono pela tela nunca passa por aqui. Falha ao ler = recusa (fail-closed).
 */
export async function criticMoveHold(board: string, card: Card, config: BoardConfig, toStatus: string): Promise<string | null> {
  try {
    const to = config.statuses.find((s) => s.id === toStatus);
    const rows = await diskCriticLedger().load();
    const planRule = isConducted(card) && isBuildStep(to);
    // fase 7 — o LOTE: o plano e a aprovação são do LÍDER. Um item lê o plano do líder e a aprovação dele contra o
    // assunto CONGELADO no item (um item sem assunto congelado espera o líder submeter o plano do lote).
    const leadId = card.batch && card.batch.lead !== card.id ? card.batch.lead : null;
    const lead = planRule && leadId ? await readCard(board, leadId).catch(() => null) : null;
    if (planRule && leadId && (!lead || lead.batch?.id !== card.batch?.id)) {
      return `o líder ${leadId} do lote deste item não foi lido (ou o lote mudou) — o item não constrói sem o plano aprovado do lote. Declare a espera (report_progress waiting).`;
    }
    if (planRule && leadId && !card.batch?.planHash) {
      return `o plano do lote ainda não foi submetido no líder ${leadId} — o item constrói depois que o plano do lote for aprovado. Declare a espera (report_progress waiting).`;
    }
    // o plano só é lido quando a régua do plano pode valer (card conduzido indo para construir)
    const planText = planRule ? await readPlan(board, lead?.id ?? card.id).catch(() => null) : null;
    // o item julga o assunto do LÍDER calculado agora: o congelado enquanto plano e critérios dos membros batem; mudou
    // um critério (do líder ou de um item) ⇒ assunto novo, sem aprovação, e o crítico (ou a pergunta) do líder roda de novo
    const subject = !planText
      ? undefined
      : lead
        ? planSubjectFor(lead, planText, await batchItemsOf(board, lead))
        : isBatchLead(card)
          ? planSubjectFor(card, planText, await batchItemsOf(board, card))
          : undefined;
    const plan = planGateVerdict({ board, card, config, to, plan: planText, rows, subject, ...(lead ? { approvalOf: lead } : {}) });
    if (plan && !plan.allowed) {
      if (plan.next === "run-critic" || plan.next === "ask-owner") void startPlanCriticNow(board, lead?.id ?? card.id).catch(() => {});
      return `${plan.reason}. Não construa antes disso: declare a espera (report_progress waiting) — o serviço avisa esta sessão com o veredito.`;
    }
    const delivery = deliveryGateVerdict({ board, card, config, to, rows });
    if (delivery && !delivery.allowed) {
      if (delivery.next === "run-verifier") void startDeliveryVerifierNow(board, card.id, toStatus).catch(() => {});
      return delivery.reason;
    }
    return null;
  } catch (err) {
    return `a régua dos críticos não pôde ser lida (${err instanceof Error ? err.message : String(err)}) — sem ela, o movimento espera`;
  }
}

/**
 * Um AGENTE quer tirar o driver deste card (`set_card_driver(null)`): pode? Recusa enquanto o card conduzido não passou
 * pelo «vai» do plano — está ANTES do passo de construir e o portão do plano ainda não deixaria entrar nele. Sem isto,
 * limpar → mover para construir → pôr o driver de volta pulava o crítico (o portão só olha card conduzido). Depois de
 * construir (entregar, encerrar), limpar é o fim normal da condução. Falha ao ler = recusa (fail-closed). PURA na régua.
 */
export async function driverClearHold(board: string, cardId: string): Promise<string | null> {
  try {
    const [card, config] = await Promise.all([readCard(board, cardId), readBoardConfig(board)]);
    if (!card || !isConducted(card)) return null;
    const build = config.statuses.find((s) => isBuildStep(s));
    if (!build) return null;
    const idx = (id: string | null | undefined) => config.statuses.findIndex((s) => s.id === id);
    if (idx(card.status) < 0 || idx(card.status) >= idx(build.id)) return null;
    const plan = await readPlan(board, cardId).catch(() => null);
    const subject = plan && isBatchLead(card) ? planSubjectFor(card, plan, await batchItemsOf(board, card)) : undefined;
    const verdict = planGateVerdict({ board, card, config, to: build, plan, rows: await diskCriticLedger().load(), subject });
    if (!verdict || verdict.allowed) return null;
    return "o plano deste card ainda não foi aprovado — um agente não tira a condução antes do «vai» do plano (o portão do crítico valeria só para card conduzido). Para devolver o card ao fluxo, o operador usa «Devolver ao fluxo» na tela.";
  } catch (err) {
    return `a régua do plano não pôde ser lida (${err instanceof Error ? err.message : String(err)}) — a condução fica`;
  }
}

/** O verificador rodou e aprovou ESTA mudança do card? (o registro `verifier` da entrega — delivery-audit-channel.ts). */
export async function verifiedDeliveryNow(board: string, card: Card): Promise<{ runId?: string; model?: string } | null> {
  const row = verifiedDelivery(await diskCriticLedger().load(), board, card);
  return row ? { ...(row.runId ? { runId: row.runId } : {}), ...(row.model ? { model: row.model } : {}) } : null;
}

/** A varredura do tick da frota: a fila (o que esperava ou falhou) e as perguntas `guardrail` abertas sem revisor. */
export const CRITICS_SWEEP_MIN_INTERVAL_MS = 5 * 60_000;
const LAST_SWEEP_KEY = Symbol.for("agileharness.critics.lastSweep");
export async function maybeSweepCritics(now: number = Date.now()): Promise<unknown> {
  const store = globalThis as unknown as { [LAST_SWEEP_KEY]?: number };
  if (now - (store[LAST_SWEEP_KEY] ?? 0) < CRITICS_SWEEP_MIN_INTERVAL_MS) return null;
  store[LAST_SWEEP_KEY] = now;
  return runAsService(async () => {
    const queue = diskCriticQueue();
    const queued = await queue.load();
    const found: CriticPending[] = [];
    for (const b of await listBoards().catch(() => [])) {
      const [config, cards] = await Promise.all([readBoardConfig(b.id).catch(() => null), readCards(b.id).catch(() => [] as Card[])]);
      // board só de organização: nenhum ator automático age nele (organize-only.ts) — nem o revisor do diff
      if (config && !isOrganizeOnly(config)) found.push(...guardrailCandidates(b.id, cards, config, [...queued, ...found]));
    }
    if (found.length) await queue.save([...queued, ...found.map((p) => ({ ...p, at: new Date(now).toISOString() }))]);
    return sweepCritics(defaultCriticDeps(), queue, proof);
  });
}
