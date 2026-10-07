// O JUIZ DA TRIAGEM (runner/triage-judge.ts), ligado à produção. Resolvido POR CHAMADA como o proxy: o master, os
// limites e o binário vêm do settings VIVO, então ligar/desligar não pede restart.

import { ORGANIZE_ONLY_WHY, isOrganizeOnly, organizeOnlyNow } from "@/lib/storymap/organize-only";
import path from "node:path";
import { evaluateAutorunOnEntry } from "@/lib/notifications/server/channels/autorun-eval";
import { runnerStateDir } from "@/lib/storymap/paths";
import { readPrdWithContext } from "@/lib/storymap/board-strategy";
import { listBoards, readBoardConfig, readCards } from "@/lib/storymap/repo";
import { runClaudeJson } from "@/lib/storymap/smart-capture/claude";
import { planTriageJudgement, type TriageJudgePlan, type TriageOtherBoard } from "@/lib/storymap/triage/judge";
import { updateCardOnDisk } from "@/lib/storymap/write";
import type { Card } from "@/lib/storymap/types";
import { loadRunnerConfig } from "./config";
import { automationAdmission, diskProxyLedger } from "./proxy-deps";
import { appendTransition } from "./transitions";
import { appendSystemDecision, newSystemDecisionId } from "./decision-log";
import { triageJudgeEntry } from "@/lib/storymap/system-decisions";
import { judgeTriageCard, sweepTriageJudge, type TriageJudgeDeps, type TriageJudgeSweepReport } from "./triage-judge";
import { boardGateNow } from "./board-pace-store";

/** `storymap/.runner/triage-judge-ledger.json` — as tentativas por card (gitignored com o resto de .runner/). */
export function triageJudgeLedgerPath(): string {
  return path.join(runnerStateDir(), "triage-judge-ledger.json");
}

/** O ator do juiz no ledger de transições — um AGENTE, nunca "human" (a medição de toques depende disto). */
export const TRIAGE_JUDGE_ACTOR = "run:triage-judge" as const;
/** O teto de custo de UM julgamento (um PRD + um card, num modelo de raciocínio médio). */
export const TRIAGE_JUDGE_BUDGET_USD = 0.6;

const today = () => new Date().toISOString().slice(0, 10);
const isStaging = (card: Card, statuses: Array<{ id: string; staging?: boolean }>) => statuses.find((s) => s.id === card.status)?.staging === true;

export function defaultTriageJudgeDeps(): TriageJudgeDeps {
  return {
    ledger: diskProxyLedger(triageJudgeLedgerPath()),
    listBoards: async () => (await listBoards()).map((b) => b.id),
    readBoardConfig: (board) => readBoardConfig(board).catch(() => null),
    readCards: (board) => readCards(board),
    // o PRD + o contexto dos agentes (o PRD antigo virou os dois; um formato 1 ainda não migrado já chega no novo)
    readPrd: (board) => readPrdWithContext(board).catch(() => null),
    masterEnabled: () => loadRunnerConfig().autorun.enabled,
    boardGate: boardGateNow,
    admission: automationAdmission,
    judge: (prompt) =>
      runClaudeJson(prompt, { model: "sonnet", effort: "medium", maxBudgetUSD: TRIAGE_JUDGE_BUDGET_USD, context: { label: "Juiz da triagem", view: "triagem" } }),
    // O escritor: re-planeja sobre o card FRESCO sob o lock — o que chega ao disco é julgado sobre o estado de agora.
    apply: async (board, cardId, judgement) => {
      const [config, cards] = await Promise.all([readBoardConfig(board), readCards(board)]);
      let plan: TriageJudgePlan | null = null;
      await updateCardOnDisk(board, cardId, (fresh) => {
        if (!isStaging(fresh, config.statuses) || fresh.triageDecision) return null;
        plan = planTriageJudgement(fresh, judgement, config, cards, { today: today(), by: "triage-judge" });
        // `route` só grava as classes do DONO que o juiz marcou (elas viajam com o card); o efeito é a mudança de board (o
        // `route` abaixo).
        if (plan.action === "route") return plan.card.businessClasses !== fresh.businessClasses ? plan.card : null;
        return plan.card;
      });
      return plan;
    },
    otherBoards: async (board) => {
      const out: TriageOtherBoard[] = [];
      for (const b of await listBoards()) {
        if (b.id === board) continue;
        const cfg = await readBoardConfig(b.id).catch(() => null);
        if (!cfg) continue;
        // Board SÓ DE ORGANIZAÇÃO (organize-only.ts) nunca é destino do roteamento: nada chega nele sozinho.
        if (isOrganizeOnly(cfg)) continue;
        const prd = await readPrdWithContext(b.id).catch(() => null);
        out.push({
          id: b.id,
          name: b.name,
          ...(cfg.package ? { package: cfg.package } : {}),
          ...(cfg.sharedPackages?.length ? { sharedPackages: cfg.sharedPackages } : {}),
          ...(cfg.ownsPaths?.length ? { ownsPaths: cfg.ownsPaths } : {}),
          scope: prd,
        });
      }
      return out;
    },
    // Mandar ao board certo: a MESMA mudança de board da tela e da tool (card-transfer-service.ts), atribuída ao juiz; o
    // juiz de lá é cutucado na hora (o card chegou sem veredito, na Triagem de lá).
    route: async (board, cardId, toBoard, reason) => {
      // Defesa em profundidade: mesmo que o juiz nomeie um board só de organização, a mudança automática não acontece.
      if (organizeOnlyNow(toBoard)) return { ok: false, error: `o board «${toBoard}» é ${ORGANIZE_ONLY_WHY.replace(/^board /, "")}: nada chega nele pela triagem` };
      const { transferCard, defaultCardTransferDeps } = await import("./card-transfer-service");
      const r = await transferCard(defaultCardTransferDeps(), { fromBoard: board, toBoard, cardId, reason, by: "triage-judge" });
      if (!r.ok) return { ok: false, error: r.error };
      void nudgeTriageJudge(toBoard, cardId).catch(() => {});
      return { ok: true };
    },
    deferChild: async (board, cardId, anchor) => {
      const d = anchor.deferred!;
      const root = d.root ?? anchor.id;
      const marked = await updateCardOnDisk(board, cardId, (fresh) =>
        fresh.deferred || fresh.triageDecision ? null : { ...fresh, deferred: { reason: d.reason, since: today(), ...(d.reviewOn ? { reviewOn: d.reviewOn } : {}), by: "system", root } },
      );
      if (!marked) return;
      await appendSystemDecision({
        v: 1,
        id: newSystemDecisionId(),
        at: new Date().toISOString(),
        board,
        cardId,
        agent: "triage-judge",
        kind: "stall-retry",
        what: `Manteve adiado «${marked.title}» — nasceu de «${anchor.title}», que está adiado`,
        why: `${d.reason}. O juiz da triagem não aceita card que nasce de algo que o dono adiou; ele volta quando «${anchor.title}» voltar.`,
      }).catch(() => {});
    },
    hold: async (board, cardId, reason) => {
      const config = await readBoardConfig(board);
      await updateCardOnDisk(board, cardId, (fresh) =>
        !isStaging(fresh, config.statuses) || fresh.triageDecision
          ? null
          : { ...fresh, needsHumanReview: true, triageDecision: { verdict: "hold", reason, by: "triage-judge", at: today() } },
      );
    },
    after: async (board, cardId, plan) => {
      if (plan.action === "accept" || plan.action === "discard" || plan.action === "duplicate") {
        await appendTransition({ board, cardId, from: plan.card.triageDecision?.from ?? null, to: plan.to, actor: TRIAGE_JUDGE_ACTOR, note: `triage-judge:${plan.action}` });
      }
      // o aceite aterrissa numa raia que pode ser autorun — a mesma cascata que o «Aceitar» humano dispara.
      if (plan.action === "accept") await evaluateAutorunOnEntry(board, cardId).catch(() => {});
      // o registro do que o juiz decidiu em nome do dono, com o «Desfazer» (volta à Triagem) — levar ao dono não entra.
      const entry = triageJudgeEntry(board, plan.card, { at: new Date().toISOString(), id: newSystemDecisionId() });
      if (entry) await appendSystemDecision(entry);
    },
  };
}

/** A varredura é a REDE DE SEGURANÇA (a porta normal é o nudge de quando o card entra na Triagem). */
export const TRIAGE_JUDGE_SWEEP_MIN_INTERVAL_MS = 5 * 60_000;
const LAST_SWEEP_KEY = Symbol.for("agileharness.triage-judge.lastSweep");

/** O tick da frota: uma varredura quando a última tem mais de 5 min, senão nada. */
export async function maybeSweepTriageJudge(now: number = Date.now()): Promise<TriageJudgeSweepReport | null> {
  const store = globalThis as unknown as { [LAST_SWEEP_KEY]?: number };
  if (now - (store[LAST_SWEEP_KEY] ?? 0) < TRIAGE_JUDGE_SWEEP_MIN_INTERVAL_MS) return null;
  store[LAST_SWEEP_KEY] = now;
  return sweepTriageJudge(defaultTriageJudgeDeps());
}

/** A porta normal: um card acabou de entrar na Triagem (fire-and-forget do chamador). */
export function nudgeTriageJudge(board: string, cardId: string): Promise<unknown> {
  return judgeTriageCard(defaultTriageJudgeDeps(), board, cardId);
}
