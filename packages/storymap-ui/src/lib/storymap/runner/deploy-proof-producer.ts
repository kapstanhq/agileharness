// O PRODUTOR DA PROVA — o que o sistema faz quando o deploy sai com 3 pedindo uma prova (`needs-proof`; política só-negócio,
// item 9). Núcleo DI (as deps de produção moram em deploy-proof-deps.ts), irmão do proxy e do juiz da triagem, com as
// mesmas travas:
//   • INDEPENDENTE: a revisão de segurança é um run à parte, de contexto limpo (não o agente que escreveu o código),
//     sobre EXATAMENTE o assunto pedido (a mudança base..head daqueles arquivos, ou o conteúdo daquelas regras);
//   • O CÓDIGO MONTA O VEREDITO: o assunto vem do pedido, o formato é o do alvo, e quem grava é a receita do alvo, que
//     recalcula o hash e recusa assunto velho — o modelo só julga;
//   • LIMITADO: tentativas por assunto (no teto, um card de conserto) e rodadas de republicação por card (um HEAD que
//     não para de andar não vira laço);
//   • NUNCA O DONO: aprovado ⇒ republica pelo mesmo caminho do «Re-publicar»; reprovado ⇒ o card volta para correção
//     com os achados; uma prova que o AH não produz (um ensaio de rollback) ⇒ card de conserto;
//   • os mesmos interruptores do autorun (master, o portão do board — board-pace.ts —, a admissão da janela da conta e da máquina); o que
//     espera fica numa fila durável que a varredura do tick da frota retoma.
// Tudo o que ele decide entra no registro de decisões do sistema (system-decisions.ts, kind `security-review`).

import type { BoardConfig, Card } from "@/lib/storymap/types";
import type { SystemDecision } from "@/lib/storymap/system-decisions";
import { gateOf, type BoardGatePort } from "./board-pace";
import type { ProxyLedgerEntry, ProxyLedgerStore } from "./proxy";
import { newSystemDecisionId } from "./decision-log";
import {
  composeSecurityVerdict,
  isVerdictApproval,
  openNeedsProof,
  type DeployExit3Report,
  type ProofSubject,
  type ReviewerOutput,
  type SecurityReviewRequest,
  type SecurityVerdict,
} from "./deploy-proof";

/** Revisões por ASSUNTO, para sempre — no teto, um card de conserto. */
export const MAX_REVIEW_ATTEMPTS = 2;
/** Republicações pelo produtor, por card — um HEAD que não para de andar não vira laço de deploys. */
export const MAX_PROOF_ROUNDS = 3;
const LEDGER_MAX_ROWS = 500;

/** Um pedido de prova esperando o produtor (a fila durável). */
export interface ProofPending {
  board: string;
  cardId: string;
  report: DeployExit3Report;
  at: string;
}

/** O que o revisor lê: a mudança (diff) e/ou o conteúdo dos arquivos no HEAD. */
export interface ReviewMaterial {
  diff?: string;
  files: Array<{ path: string; text: string }>;
}

export interface DeployProofDeps {
  ledger: ProxyLedgerStore;
  pending: { load(): Promise<ProofPending[]>; save(list: ProofPending[]): Promise<void> };
  masterEnabled(): boolean;
  /** o portão do board (desarmado, pausado, devagar) — board-pace.ts; ausente ⇒ só a configuração responde. */
  boardGate?: BoardGatePort;
  admission(): string | null;
  readCard(board: string, cardId: string): Promise<Card | null>;
  readBoardConfig(board: string): Promise<BoardConfig | null>;
  /** o assunto em texto (git diff / o conteúdo no HEAD), lido do checkout do alvo, só leitura. */
  materialize(subject: ProofSubject): Promise<ReviewMaterial | { error: string }>;
  /** o revisor INDEPENDENTE (contexto limpo) — a saída validada, ou o erro. */
  review(input: { board: string; cardId: string; request: SecurityReviewRequest; material: ReviewMaterial }): Promise<{ runId: string; model: string; output?: ReviewerOutput; error?: string }>;
  /** grava o veredito pela receita do alvo (`request.record`) — `stale` quando o assunto já não é o do checkout. */
  recordVerdict(verdict: SecurityVerdict, request: SecurityReviewRequest): Promise<{ ok: true } | { ok: false; stale: boolean; error: string }>;
  resolveFinding(board: string, cardId: string): Promise<void>;
  /** o «Re-publicar» de sempre: re-roda o efeito de entrada do passo de publicar, como o próprio serviço. */
  republish(board: string, cardId: string): Promise<{ ok: boolean; error?: string }>;
  /** veredito negativo: reabre o card por correção com os achados (deploy-proof.ts `securityReopen`). */
  reopen(board: string, cardId: string, verdict: SecurityVerdict): Promise<boolean>;
  /** abre um card de conserto técnico na Triagem (o juiz o aceita) — o id, ou null. */
  openFixCard(board: string, cardId: string, reason: string): Promise<string | null>;
  record(entry: SystemDecision): Promise<void>;
  now?(): number;
  log?(line: string): void;
}

export type ProofOutcome =
  | { action: "skipped"; reason: string }
  | { action: "waiting"; reason: string }
  | { action: "failed"; reason: string }
  | { action: "republished" }
  | { action: "reopened" }
  | { action: "fix-card"; reason: string };

const hexOf = (hash: string) => hash.replace(/^sha256:/, "");
const subjectKey = (board: string, cardId: string, s: ProofSubject) => `${board}/${cardId}/proof/${hexOf(s.hash)}`;
const roundsKey = (board: string, cardId: string) => `${board}/${cardId}#proof-rounds`;
const fixKey = (board: string, cardId: string, why: string) => `${board}/${cardId}#proof-fix:${why}`;
const upsert = (rows: ProxyLedgerEntry[], row: ProxyLedgerEntry) => [...rows.filter((e) => e.key !== row.key), row].slice(-LEDGER_MAX_ROWS);
const subjectLabel = (s: ProofSubject) =>
  `${s.kind === "content" ? "o conteúdo de" : "a mudança em"} ${s.files.slice(0, 3).join(", ")}${s.files.length > 3 ? ` (+${s.files.length - 3})` : ""}`;

/**
 * UM pedido: revisa cada assunto que falta, grava os vereditos e — tudo aprovado — republica. Nunca lança.
 */
export async function produceDeployProofs(deps: DeployProofDeps, pending: ProofPending): Promise<ProofOutcome> {
  const log = deps.log ?? ((l: string) => console.log(`[deploy-proof] ${l}`));
  const { board, cardId, report } = pending;
  const nowIso = () => new Date((deps.now ?? Date.now)()).toISOString();
  try {
    const [card, config] = await Promise.all([deps.readCard(board, cardId), deps.readBoardConfig(board)]);
    if (!card || !config) return { action: "skipped", reason: "card ou board ilegível" };
    const def = config.statuses.find((s) => s.id === card.status);
    if (!def?.onEnter || !openNeedsProof(card)) return { action: "skipped", reason: "o card não espera mais a prova no passo de publicar" };
    if (!deps.masterEnabled()) return { action: "waiting", reason: "autorun desligado — o produtor espera" };
    const gate = gateOf(deps.boardGate, board, config);
    if (gate.held) return { action: "waiting", reason: `${gate.why} — o produtor espera` };
    const refused = deps.admission();
    if (refused) return { action: "waiting", reason: `máquina/janela saturada: ${refused}` };

    let rows = await deps.ledger.load();
    const decision = (what: string, why: string): SystemDecision => ({
      v: 1,
      id: newSystemDecisionId(),
      at: nowIso(),
      board,
      cardId,
      agent: "security-reviewer",
      kind: "security-review",
      what,
      why,
    });
    // um card de conserto por motivo (e por card) — nunca repetido.
    const fixOnce = async (why: string, reason: string): Promise<ProofOutcome> => {
      const key = fixKey(board, cardId, why);
      if (!rows.some((e) => e.key === key)) {
        const fixId = await deps.openFixCard(board, cardId, reason).catch(() => null);
        rows = upsert(rows, { key, attempts: 1, lastAt: nowIso(), outcome: "answered", ...(fixId ? { detail: fixId } : {}) });
        await deps.ledger.persist(rows);
        await deps.record({ ...decision(`Abriu um card de conserto para «${card.title}»${fixId ? ` (${fixId})` : ""}`, reason), agent: "system", kind: "recovery-fix-card", ...(fixId ? { cardId: fixId, undo: { kind: "discard-card" as const, cardId: fixId } } : {}) }).catch(() => {});
      }
      return { action: "fix-card", reason };
    };

    const rounds = rows.find((e) => e.key === roundsKey(board, cardId))?.attempts ?? 0;
    if (rounds >= MAX_PROOF_ROUNDS) {
      return fixOnce("rounds", `o deploy de «${card.title}» pediu prova ${rounds} vezes e a publicação não assentou — o conserto vira trabalho, sem parar o dono`);
    }

    let stale = false;
    for (const request of report.security) {
      const key = subjectKey(board, cardId, request.subject);
      const prior = rows.find((e) => e.key === key);
      if (prior?.outcome === "answered") continue; // já aprovado (um restart no meio)
      if ((prior?.attempts ?? 0) >= MAX_REVIEW_ATTEMPTS) {
        return fixOnce(`review:${hexOf(request.subject.hash).slice(0, 12)}`, `a revisão de segurança independente de ${subjectLabel(request.subject)} não saiu depois de ${MAX_REVIEW_ATTEMPTS} tentativas`);
      }
      const attempts = (prior?.attempts ?? 0) + 1;
      rows = upsert(rows, { key, attempts, lastAt: nowIso(), outcome: "running" });
      await deps.ledger.persist(rows);

      const fail = async (why: string): Promise<ProofOutcome> => {
        rows = upsert(rows, { key, attempts, lastAt: nowIso(), outcome: "failed", detail: why.slice(0, 300) });
        await deps.ledger.persist(rows);
        log(`${board}/${cardId}: revisão de ${subjectLabel(request.subject)} falhou (${attempts}/${MAX_REVIEW_ATTEMPTS}): ${why}`);
        return { action: "failed", reason: why };
      };
      const material = await deps.materialize(request.subject);
      if ("error" in material) return fail(`o assunto não pôde ser lido: ${material.error}`);
      const res = await deps.review({ board, cardId, request, material });
      if (!res.output) return fail(res.error ?? "o revisor não devolveu um veredito");
      const verdict = composeSecurityVerdict(request.subject, res.output, { agent: request.reviewer, runId: res.runId, model: res.model, at: nowIso() });
      const recorded = await deps.recordVerdict(verdict, request);
      if (!recorded.ok) {
        if (recorded.stale) {
          // o HEAD andou: este assunto morreu — republicar traz o pedido do assunto de agora.
          rows = upsert(rows, { key, attempts, lastAt: nowIso(), outcome: "declined", detail: "assunto velho" });
          await deps.ledger.persist(rows);
          stale = true;
          continue;
        }
        return fail(`a gravação do veredito recusou: ${recorded.error}`);
      }
      rows = upsert(rows, { key, attempts, lastAt: nowIso(), outcome: "answered" });
      await deps.ledger.persist(rows);
      if (!isVerdictApproval(verdict)) {
        await deps.reopen(board, cardId, verdict).catch(() => false);
        await deps
          .record(decision(`Revisão de segurança independente reprovou «${card.title}» (${subjectLabel(request.subject)}) — o card voltou para correção com os achados`, verdict.summary))
          .catch(() => {});
        return { action: "reopened" };
      }
      await deps.record(decision(`Revisão de segurança independente aprovou ${subjectLabel(request.subject)} de «${card.title}»`, verdict.summary)).catch(() => {});
    }

    if (report.other.length) {
      const list = report.other.map((o) => `${o.proof}${o.run ? ` (${o.run})` : ""}${o.detail ? `: ${o.detail}` : ""}`).join("; ");
      return fixOnce(`other:${report.head ?? ""}`, `o deploy de «${card.title}» pede provas que o AgileHarness não produz: ${list}`);
    }

    // A rodada conta ANTES de republicar: uma republicação que lança (e que a varredura tenta de novo) continua
    // limitada por MAX_PROOF_ROUNDS.
    rows = upsert(rows, { key: roundsKey(board, cardId), attempts: rounds + 1, lastAt: nowIso(), outcome: "running" });
    await deps.ledger.persist(rows);
    // REPUBLICA PRIMEIRO, fecha o finding DEPOIS. O finding de needs-proof aberto é a única coisa que mantém o card
    // à vista deste produtor (o `skipped` lá em cima): fechá-lo antes de uma republicação que falha deixava o card
    // parado no passo de publicar, sem nada pendente e sem ninguém avisado (caso real: a
    // revisão aprovou, o finding fechou, a republicação não aconteceu e nada ficou registrado).
    const pub = await deps.republish(board, cardId);
    if (!pub.ok) {
      const reason = `a republicação recusou (rodada ${rounds + 1}/${MAX_PROOF_ROUNDS}): ${pub.error ?? "?"}`;
      log(`${board}/${cardId}: ${reason}`);
      return { action: "failed", reason };
    }
    // O deploy já foi disparado: uma falha ao fechar o finding não pode virar uma SEGUNDA republicação (o desfecho
    // é final e o pedido sai da fila). O finding que sobrar aberto é fechado pelo settle do próprio deploy.
    await deps.resolveFinding(board, cardId).catch((err) => log(`${board}/${cardId}: republicado, mas o finding de prova não fechou: ${err instanceof Error ? err.message : String(err)}`));
    await deps
      .record(decision(`Republicou «${card.title}»${stale ? " para receber o pedido do código de agora" : " com a prova de segurança"}`, stale ? "o assunto revisado ficou velho (o código andou)" : "todas as provas que faltavam foram produzidas"))
      .catch(() => {});
    log(`${board}/${cardId}: prova ${stale ? "velha — " : ""}republicado`);
    return { action: "republished" };
  } catch (err) {
    // Nunca em silêncio: o chamador é fire-and-forget e a varredura só devolve a ação — sem esta linha uma exceção
    // aqui não deixava rastro nenhum.
    const reason = err instanceof Error ? err.message : String(err);
    log(`${board}/${cardId}: o produtor da prova falhou — ${reason}`);
    return { action: "failed", reason };
  }
}

/** Desfechos finais — o pedido sai da fila. `waiting`/`failed` ficam para a varredura. */
const FINAL: ReadonlySet<ProofOutcome["action"]> = new Set(["skipped", "republished", "reopened", "fix-card"]);

/** O pedido entra na fila durável e é tentado AGORA. Nunca lança. */
export async function startDeployProofs(deps: DeployProofDeps, pending: ProofPending): Promise<ProofOutcome> {
  const list = (await deps.pending.load().catch(() => [] as ProofPending[])).filter((p) => !(p.board === pending.board && p.cardId === pending.cardId));
  await deps.pending.save([...list, pending]).catch(() => {});
  const out = await produceDeployProofs(deps, pending);
  if (FINAL.has(out.action)) {
    const now = (await deps.pending.load().catch(() => [] as ProofPending[])).filter((p) => !(p.board === pending.board && p.cardId === pending.cardId));
    await deps.pending.save(now).catch(() => {});
  }
  return out;
}

/** A varredura: cada pedido da fila, um a um; o que termina sai. Nunca lança. */
export async function sweepDeployProofs(deps: DeployProofDeps): Promise<Array<{ board: string; cardId: string; action: ProofOutcome["action"] }>> {
  const report: Array<{ board: string; cardId: string; action: ProofOutcome["action"] }> = [];
  for (const p of await deps.pending.load().catch(() => [] as ProofPending[])) {
    const out = await produceDeployProofs(deps, p);
    report.push({ board: p.board, cardId: p.cardId, action: out.action });
    if (FINAL.has(out.action)) {
      const rest = (await deps.pending.load().catch(() => [] as ProofPending[])).filter((x) => !(x.board === p.board && x.cardId === p.cardId));
      await deps.pending.save(rest).catch(() => {});
    }
  }
  return report;
}
