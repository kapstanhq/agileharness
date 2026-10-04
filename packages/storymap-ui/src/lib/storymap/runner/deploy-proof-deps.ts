// O PRODUTOR DA PROVA (deploy-proof-producer.ts) ligado à produção. Resolvido por chamada, como o proxy: o master,
// os limites e o binário vêm do settings VIVO. O assunto é lido do checkout do ALVO (a raiz do repositório que o
// serviço gerencia — onde o deploy roda e onde a receita do alvo recalcula o hash), só por leitura de git/arquivos;
// o único write é a receita do próprio alvo que grava o veredito no store de provas dele.

import { execFile } from "node:child_process";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { findRepoRoot, runnerStateDir } from "@/lib/storymap/paths";
import { readBoardConfig, readCard } from "@/lib/storymap/repo";
import { republishRefusal } from "@/lib/storymap/preconditions";
import { makeDraftCard } from "@/lib/storymap/draft";
import { updateCardOnDisk } from "@/lib/storymap/write";
import { atomicWriteFile } from "@/lib/storymap/atomic-write";
import type { Card } from "@/lib/storymap/types";
import { resolvedClaudeBin } from "./claude-bin";
import { loadRunnerConfig } from "./config";
import { appendSystemDecision } from "./decision-log";
import { automationAdmission, diskProxyLedger } from "./proxy-deps";
import { appendTransition } from "./transitions";
import { withHarnessTempDir } from "./temp";
import { resolveNeedsProofFinding, runDeclaredRecord, securityReopen, type ProofSubject } from "./deploy-proof";
import { resolveDeclaredProgram } from "./product-deploy";
import { produceDeployProofs, startDeployProofs, sweepDeployProofs, type DeployProofDeps, type ProofPending, type ReviewMaterial } from "./deploy-proof-producer";
import { SECURITY_REVIEW_MODEL, agentRoleBody, spawnSecurityReviewer } from "./security-review-spawn";
import { boardGateNow } from "./board-pace-store";
import { fixCardBoard, originLine } from "./fix-card-board";

const pexec = promisify(execFile);
const GIT_MAX_BUFFER = 8 * 1024 * 1024;

export function deployProofLedgerPath(): string {
  return path.join(runnerStateDir(), "deploy-proof-ledger.json");
}
export function deployProofPendingPath(): string {
  return path.join(runnerStateDir(), "deploy-proof-pending.json");
}

const today = () => new Date().toISOString().slice(0, 10);

async function git(args: string[]): Promise<string> {
  const r = await pexec("git", args, { cwd: findRepoRoot(), maxBuffer: GIT_MAX_BUFFER, timeout: 60_000 });
  return String(r.stdout ?? "");
}

/** O assunto em texto, do checkout do alvo, só leitura: o diff base..head (e os arquivos no head), ou o conteúdo. */
async function materialize(subject: ProofSubject): Promise<ReviewMaterial | { error: string }> {
  try {
    if (subject.kind === "diff") {
      if (!subject.base || !subject.head) return { error: "assunto de diff sem base/head" };
      const diff = await git(["diff", "--no-color", subject.base, subject.head, "--", ...subject.files]);
      const files: ReviewMaterial["files"] = [];
      for (const f of subject.files) {
        const text = await git(["show", `${subject.head}:${f}`]).catch(() => "(arquivo removido nesta mudança)");
        files.push({ path: f, text });
      }
      return { diff, files };
    }
    const root = findRepoRoot();
    const files: ReviewMaterial["files"] = [];
    for (const f of subject.files) {
      // `firebase.json#firestore` = a seção de um arquivo: o arquivo inteiro vai (o revisor lê a seção nomeada).
      const real = f.split("#")[0];
      const text = await fsp.readFile(path.join(root, real), "utf8").catch(() => "(arquivo ausente)");
      files.push({ path: f, text });
    }
    return { files };
  } catch (err) {
    return { error: String(err instanceof Error ? err.message : err).slice(0, 200) };
  }
}

/** O papel do revisor que o ALVO declara (`.claude/agents/<nome>.md`), ou null. */
async function reviewerRole(reviewer: string): Promise<string | null> {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(reviewer)) return null;
  const md = await fsp.readFile(path.join(findRepoRoot(), ".claude", "agents", `${reviewer}.md`), "utf8").catch(() => null);
  return md ? agentRoleBody(md) : null;
}

async function pendingLoad(): Promise<ProofPending[]> {
  try {
    const parsed = JSON.parse(await fsp.readFile(deployProofPendingPath(), "utf8")) as { pending?: unknown };
    return Array.isArray(parsed.pending) ? (parsed.pending as ProofPending[]).filter((p) => p && typeof p.board === "string" && typeof p.cardId === "string" && p.report) : [];
  } catch {
    return [];
  }
}
async function pendingSave(list: ProofPending[]): Promise<void> {
  await fsp.mkdir(path.dirname(deployProofPendingPath()), { recursive: true });
  await atomicWriteFile(deployProofPendingPath(), JSON.stringify({ v: 1, pending: list }, null, 2));
}

export function defaultDeployProofDeps(): DeployProofDeps {
  return {
    ledger: diskProxyLedger(deployProofLedgerPath()),
    pending: { load: pendingLoad, save: pendingSave },
    masterEnabled: () => loadRunnerConfig().autorun.enabled,
    boardGate: boardGateNow,
    admission: automationAdmission,
    readCard: (board, cardId) => readCard(board, cardId).catch(() => null),
    readBoardConfig: (board) => readBoardConfig(board).catch(() => null),
    materialize,
    review: async ({ board, cardId, request, material }) => {
      let claudeBin: string;
      try {
        claudeBin = resolvedClaudeBin({ name: loadRunnerConfig().autorun.claudeBin });
      } catch (err) {
        return { runId: "none", model: SECURITY_REVIEW_MODEL, error: `binário claude indisponível: ${err instanceof Error ? err.message : String(err)}` };
      }
      const role = await reviewerRole(request.reviewer);
      return spawnSecurityReviewer({ board, cardId, reviewer: request.reviewer, role, subject: request.subject, material, model: SECURITY_REVIEW_MODEL }, { claudeBin });
    },
    recordVerdict: async (verdict) =>
      withHarnessTempDir("security-verdict", async (dir) => {
        const file = path.join(dir, "verdict.json");
        await fsp.writeFile(file, `${JSON.stringify(verdict, null, 2)}\n`, "utf8");
        // O comando que GRAVA é o que o ALVO declarou (settings.yaml → deploy.proof.record.securityReview), nunca o
        // texto `request.record` que o log do deploy imprimiu: essa linha é saída de comando, não configuração.
        return runDeclaredRecord("securityReview", file, {
          resolveProgram: (name) => resolveDeclaredProgram(name),
          exec: async (program, args) => {
            await pexec(program, args, { cwd: findRepoRoot(), timeout: 120_000, maxBuffer: GIT_MAX_BUFFER });
          },
        });
      }),
    resolveFinding: async (board, cardId) => {
      await updateCardOnDisk(board, cardId, (fresh) => resolveNeedsProofFinding(fresh));
    },
    // O MESMO efeito do «Re-publicar», chamado como o próprio serviço. Não passa pela server action
    // (`republishCardAction`): ela autentica QUEM chama a partir do escopo de request ambiente, e este produtor roda
    // solto, na continuação assíncrona do deploy que pediu a prova — o único passo do laço cujo resultado dependia
    // de quem tinha disparado aquele deploy. (story-ex0143: a republicação não aconteceu e não deixou rastro; a
    // causa exata não foi provada — o que se sabe está no log que o produtor passou a escrever.)
    republish: async (board, cardId) => {
      const [config, card] = await Promise.all([readBoardConfig(board), readCard(board, cardId)]);
      if (!card) return { ok: false, error: `card não encontrado: ${cardId}` };
      const refusal = republishRefusal(card, config);
      const effect = config.statuses.find((s) => s.id === card.status)?.onEnter;
      if (refusal || !effect) return { ok: false, error: refusal ?? "este passo não dispara ação automática" };
      const { runEntryEffect } = await import("./entry-effects");
      void runEntryEffect(effect, board, cardId).catch((err) => console.error(`[deploy-proof republish ${effect} ${board}/${cardId}]`, err instanceof Error ? err.message : err));
      return { ok: true };
    },
    reopen: async (board, cardId, verdict) => {
      const config = await readBoardConfig(board);
      let from: string | null = null;
      let to: string | null = null;
      await updateCardOnDisk(board, cardId, (fresh) => {
        const next = securityReopen(fresh, config, verdict, today());
        if (!next) return null;
        from = fresh.status ?? null;
        to = next.status ?? null;
        return next;
      });
      if (!to) return false;
      void appendTransition({ board, cardId, from, to, actor: "run:security-review", note: "reopen:security-review" });
      const { evaluateAutorunOnEntry } = await import("@/lib/notifications/server/channels/autorun-eval");
      await evaluateAutorunOnEntry(board, cardId).catch(() => {});
      return true;
    },
    openFixCard: async (board, cardId, reason, files) => {
      // O conserto nasce no board dos arquivos do assunto (fix-card-board.ts); sem arquivos, no do card que publica.
      const target = await fixCardBoard(board, files ?? []);
      const routed = target.routed && target.board !== board;
      const [config, card] = await Promise.all([readBoardConfig(target.board), readCard(board, cardId)]);
      const staging = config.statuses.find((s) => s.staging)?.id ?? null;
      const serves = routed ? undefined : card && (card.storyType == null || card.storyType === "user") ? card.id : (card?.serves ?? card?.parent ?? undefined);
      const draft = makeDraftCard({ type: "story", title: `Conserto: a publicação de «${card?.title ?? cardId}» pede uma prova`, status: staging, cards: [] });
      const fix: Card = {
        ...draft,
        storyType: "technical",
        ...(serves ? { serves } : {}),
        links: routed ? [] : [{ rel: "relates-to", to: cardId }],
        labels: ["prova-de-deploy"],
        body: [
          "## A prova que faltou para publicar",
          "",
          ...(routed ? originLine(board, cardId, card?.title, target) : [`- Card: ${cardId} — ${card?.title ?? ""}`]),
          `- ${reason}`,
          "- O dono não foi chamado: é trabalho técnico.",
        ].join("\n"),
      };
      const { createCardAction } = await import("@/app/actions");
      const r = await createCardAction({ boardId: target.board, card: fix, via: "triage" });
      return r.ok ? (r.data?.card.id ?? null) : null;
    },
    record: appendSystemDecision,
  };
}

/** O settle do deploy acabou de pedir uma prova: entra na fila e é tentada agora (fire-and-forget do chamador). */
export function startDeployProofsNow(pending: ProofPending): Promise<unknown> {
  return startDeployProofs(defaultDeployProofDeps(), pending);
}

/** A varredura do tick da frota (a rede de segurança: o que um restart interrompeu). No máximo a cada 5 min. */
export const DEPLOY_PROOF_SWEEP_MIN_INTERVAL_MS = 5 * 60_000;
const LAST_SWEEP_KEY = Symbol.for("agileharness.deploy-proof.lastSweep");
export async function maybeSweepDeployProofs(now: number = Date.now()): Promise<unknown> {
  const store = globalThis as unknown as { [LAST_SWEEP_KEY]?: number };
  if (now - (store[LAST_SWEEP_KEY] ?? 0) < DEPLOY_PROOF_SWEEP_MIN_INTERVAL_MS) return null;
  store[LAST_SWEEP_KEY] = now;
  return sweepDeployProofs(defaultDeployProofDeps());
}

export { produceDeployProofs };
