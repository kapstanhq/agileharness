// A AUDITORIA TÉCNICA POR AMOSTRA (technical-audit.ts) ligada à produção. Resolvida por chamada, como o produtor da
// prova: o master, os limites e o binário vêm do settings VIVO. A mudança é lida do checkout do ALVO só por leitura de
// git; o auditor é o mesmo run independente do revisor de segurança (security-review-spawn.ts), com a lente de
// ENTREGA e o papel `code-reviewer` que o alvo declara (`.claude/agents/code-reviewer.md`).

import { execFile } from "node:child_process";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { findRepoRoot, runnerStateDir } from "@/lib/storymap/paths";
import { readBoardConfig, readCard } from "@/lib/storymap/repo";
import { makeDraftCard } from "@/lib/storymap/draft";
import { atomicWriteFile } from "@/lib/storymap/atomic-write";
import type { Card, CommitRange } from "@/lib/storymap/types";
import { resolvedClaudeBin } from "./claude-bin";
import { loadRunnerConfig } from "./config";
import { appendSystemDecision } from "./decision-log";
import { automationAdmission, diskProxyLedger } from "./proxy-deps";
import type { ReviewMaterial } from "./deploy-proof-producer";
import { TECHNICAL_AUDIT_MODEL, agentRoleBody, spawnSecurityReviewer } from "./security-review-spawn";
import { startTechnicalAudit, sweepTechnicalAudits, type TechnicalAuditDeps, type TechnicalAuditPending } from "./technical-audit";
import { boardGateNow } from "./board-pace-store";

const pexec = promisify(execFile);
const GIT_MAX_BUFFER = 8 * 1024 * 1024;
/** O papel que o alvo declara para a revisão de código (o mesmo agente da lente `code` do harness-review). */
export const TECHNICAL_AUDITOR_ROLE = "code-reviewer";
/** Quantos arquivos da mudança vão inteiros (no head) junto do diff. */
const MAX_FILES = 12;

export function technicalAuditLedgerPath(): string {
  return path.join(runnerStateDir(), "technical-audit-ledger.json");
}
export function technicalAuditPendingPath(): string {
  return path.join(runnerStateDir(), "technical-audit-pending.json");
}

async function git(args: string[]): Promise<string> {
  const r = await pexec("git", args, { cwd: findRepoRoot(), maxBuffer: GIT_MAX_BUFFER, timeout: 60_000 });
  return String(r.stdout ?? "");
}

/** A mudança do card em texto, do checkout do alvo, só leitura: o diff base..head e os arquivos tocados no head. */
async function materialize(range: CommitRange): Promise<ReviewMaterial | { error: string }> {
  try {
    const diff = await git(["diff", "--no-color", range.base, range.head]);
    const names = (await git(["diff", "--name-only", range.base, range.head])).split("\n").map((l) => l.trim()).filter(Boolean);
    const files: ReviewMaterial["files"] = [];
    for (const f of names.slice(0, MAX_FILES)) {
      const text = await git(["show", `${range.head}:${f}`]).catch(() => "(arquivo removido nesta mudança)");
      files.push({ path: f, text });
    }
    return { diff, files };
  } catch (err) {
    return { error: String(err instanceof Error ? err.message : err).slice(0, 200) };
  }
}

async function auditorRole(): Promise<string | null> {
  const md = await fsp.readFile(path.join(findRepoRoot(), ".claude", "agents", `${TECHNICAL_AUDITOR_ROLE}.md`), "utf8").catch(() => null);
  return md ? agentRoleBody(md) : null;
}

async function pendingLoad(): Promise<TechnicalAuditPending[]> {
  try {
    const parsed = JSON.parse(await fsp.readFile(technicalAuditPendingPath(), "utf8")) as { pending?: unknown };
    return Array.isArray(parsed.pending)
      ? (parsed.pending as TechnicalAuditPending[]).filter((p) => p && typeof p.board === "string" && typeof p.cardId === "string")
      : [];
  } catch {
    return [];
  }
}
async function pendingSave(list: TechnicalAuditPending[]): Promise<void> {
  await fsp.mkdir(path.dirname(technicalAuditPendingPath()), { recursive: true });
  await atomicWriteFile(technicalAuditPendingPath(), JSON.stringify({ v: 1, pending: list }, null, 2));
}

export function defaultTechnicalAuditDeps(): TechnicalAuditDeps {
  return {
    ledger: diskProxyLedger(technicalAuditLedgerPath()),
    pending: { load: pendingLoad, save: pendingSave },
    masterEnabled: () => loadRunnerConfig().autorun.enabled,
    boardGate: boardGateNow,
    admission: automationAdmission,
    readCard: (board, cardId) => readCard(board, cardId).catch(() => null),
    readBoardConfig: (board) => readBoardConfig(board).catch(() => null),
    materialize,
    audit: async ({ board, cardId, card, proof, range, material }) => {
      let claudeBin: string;
      try {
        claudeBin = resolvedClaudeBin({ name: loadRunnerConfig().autorun.claudeBin });
      } catch (err) {
        return { runId: "none", model: TECHNICAL_AUDIT_MODEL, error: `binário claude indisponível: ${err instanceof Error ? err.message : String(err)}` };
      }
      return spawnSecurityReviewer(
        {
          board,
          cardId,
          reviewer: TECHNICAL_AUDITOR_ROLE,
          role: await auditorRole(),
          lens: "delivery",
          delivery: { title: card.title, proof },
          subject: { kind: "diff", hash: `head:${range.head}`, base: range.base, head: range.head, files: material.files.map((f) => f.path) },
          material,
          model: TECHNICAL_AUDIT_MODEL,
        },
        { claudeBin },
      );
    },
    openFixCard: async (board, cardId, output) => {
      const [config, card] = await Promise.all([readBoardConfig(board), readCard(board, cardId)]);
      const staging = config.statuses.find((s) => s.staging)?.id ?? null;
      const serves = card && (card.storyType == null || card.storyType === "user") ? card.id : (card?.serves ?? card?.parent ?? undefined);
      const draft = makeDraftCard({ type: "story", title: `Conserto: a auditoria técnica achou problema em «${card?.title ?? cardId}»`, status: staging, cards: [] });
      const findings = output.findings.map((f) => `- [${f.severity}] ${f.title}${f.file ? ` (${f.file})` : ""}${f.detail ? ` — ${f.detail}` : ""}`);
      const fix: Card = {
        ...draft,
        storyType: "technical",
        ...(serves ? { serves } : {}),
        links: [{ rel: "relates-to", to: cardId }],
        labels: ["auditoria-tecnica"],
        body: [
          "## O que o auditor independente achou",
          "",
          `- Entrega: ${cardId} — ${card?.title ?? ""}`,
          `- ${output.summary}`,
          ...(findings.length ? ["", ...findings] : []),
          "",
          "- O dono não foi chamado: é trabalho técnico.",
        ].join("\n"),
      };
      const { createCardAction } = await import("@/app/actions");
      const r = await createCardAction({ boardId: board, card: fix, via: "triage" });
      return r.ok ? (r.data?.card.id ?? null) : null;
    },
    record: appendSystemDecision,
  };
}

/** Uma entrega técnica caiu na amostra: entra na fila e é tentada agora (fire-and-forget do chamador). */
export function startTechnicalAuditNow(pending: TechnicalAuditPending): Promise<unknown> {
  return startTechnicalAudit(defaultTechnicalAuditDeps(), pending);
}

/** A varredura do tick da frota (a rede de segurança: o que um restart interrompeu). No máximo a cada 5 min. */
export const TECHNICAL_AUDIT_SWEEP_MIN_INTERVAL_MS = 5 * 60_000;
const LAST_SWEEP_KEY = Symbol.for("agileharness.technical-audit.lastSweep");
export async function maybeSweepTechnicalAudits(now: number = Date.now()): Promise<unknown> {
  const store = globalThis as unknown as { [LAST_SWEEP_KEY]?: number };
  if (now - (store[LAST_SWEEP_KEY] ?? 0) < TECHNICAL_AUDIT_SWEEP_MIN_INTERVAL_MS) return null;
  store[LAST_SWEEP_KEY] = now;
  return sweepTechnicalAudits(defaultTechnicalAuditDeps());
}
