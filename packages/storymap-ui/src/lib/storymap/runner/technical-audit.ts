// A AUDITORIA TÉCNICA POR AMOSTRA. Núcleo DI (as deps de produção moram em
// technical-audit-deps.ts), irmão do produtor da prova de deploy (deploy-proof-producer.ts).
//
// O dono audita só o que o usuário VÊ (telas e textos — delivery-audit.ts). Uma entrega TÉCNICA que chegou ao ar em
// só-negócio não vai para ele: uma amostra delas (`autonomy.technicalAuditSampleRate`, padrão 20%) é revista por um
// AUDITOR INDEPENDENTE — um run de contexto limpo, que não escreveu o código, sobre a mudança do card (o intervalo de
// commits) e a `## Prova da entrega` que o condutor escreveu. Sem problema ⇒ fica registrado. Com problema ⇒ um card
// de conserto na Triagem (o juiz o aceita), com os achados. NUNCA pergunta ao dono.
//   • LIMITADO: tentativas por entrega (no teto, desiste e registra — o dono não é chamado por uma auditoria que não
//     rodou; a entrega segue no ar como estava);
//   • os mesmos interruptores do autorun (master, o portão do board — board-pace.ts — e a admissão da máquina); o que espera fica numa
//     fila durável que a varredura do tick da frota retoma;
//   • tudo entra no registro de decisões do sistema (kind `technical-audit`).

import type { BoardConfig, Card, CommitRange } from "@/lib/storymap/types";
import type { SystemDecision } from "@/lib/storymap/system-decisions";
import { deliveryProofOf } from "@/lib/storymap/delivery-audit";
import { gateOf, type BoardGatePort } from "./board-pace";
import type { ProxyLedgerEntry, ProxyLedgerStore } from "./proxy";
import type { ReviewerOutput } from "./deploy-proof";
import type { ReviewMaterial } from "./deploy-proof-producer";
import { newSystemDecisionId } from "./decision-log";

/** Auditorias por entrega, para sempre — no teto, desiste e registra. */
export const TECHNICAL_AUDIT_MAX_ATTEMPTS = 2;
const LEDGER_MAX_ROWS = 500;

/** Uma entrega técnica sorteada esperando o auditor (a fila durável). */
export interface TechnicalAuditPending {
  board: string;
  cardId: string;
  /** a mudança do card no momento da entrega (o que o auditor lê). */
  range: CommitRange | null;
  at: string;
}

export interface TechnicalAuditDeps {
  ledger: ProxyLedgerStore;
  pending: { load(): Promise<TechnicalAuditPending[]>; save(list: TechnicalAuditPending[]): Promise<void> };
  masterEnabled(): boolean;
  /** o portão do board (desarmado, pausado, devagar) — board-pace.ts; ausente ⇒ só a configuração responde. */
  boardGate?: BoardGatePort;
  admission(): string | null;
  readCard(board: string, cardId: string): Promise<Card | null>;
  readBoardConfig(board: string): Promise<BoardConfig | null>;
  /** a mudança em texto (git diff base..head e os arquivos no head), do checkout do alvo, só leitura. */
  materialize(range: CommitRange): Promise<ReviewMaterial | { error: string }>;
  /** o auditor INDEPENDENTE (contexto limpo) — a saída validada, ou o erro. */
  audit(input: { board: string; cardId: string; card: Card; proof: string | null; range: CommitRange; material: ReviewMaterial }): Promise<{
    runId: string;
    model: string;
    output?: ReviewerOutput;
    error?: string;
  }>;
  /** abre o card de conserto na Triagem com os achados — o id, ou null. */
  openFixCard(board: string, cardId: string, output: ReviewerOutput): Promise<string | null>;
  record(entry: SystemDecision): Promise<void>;
  now?(): number;
  log?(line: string): void;
}

export type TechnicalAuditOutcome =
  | { action: "skipped"; reason: string }
  | { action: "waiting"; reason: string }
  | { action: "failed"; reason: string }
  | { action: "gave-up"; reason: string }
  | { action: "passed" }
  | { action: "fix-card"; fixId: string | null };

/** O resultado encerra o pedido (sai da fila)? `waiting` e `failed` voltam na varredura. */
export function isFinalAuditOutcome(o: TechnicalAuditOutcome): boolean {
  return o.action !== "waiting" && o.action !== "failed";
}

const auditKey = (p: Pick<TechnicalAuditPending, "board" | "cardId" | "range">) => `${p.board}/${p.cardId}/technical-audit/${p.range?.head ?? "sem-intervalo"}`;
const upsert = (rows: ProxyLedgerEntry[], row: ProxyLedgerEntry) => [...rows.filter((e) => e.key !== row.key), row].slice(-LEDGER_MAX_ROWS);

/** UMA entrega sorteada: o auditor revisa; problema ⇒ card de conserto. Nunca lança, nunca chama o dono. */
export async function auditTechnicalDelivery(deps: TechnicalAuditDeps, pending: TechnicalAuditPending): Promise<TechnicalAuditOutcome> {
  const log = deps.log ?? ((l: string) => console.log(`[technical-audit] ${l}`));
  const { board, cardId, range } = pending;
  const nowIso = () => new Date((deps.now ?? Date.now)()).toISOString();
  try {
    const [card, config] = await Promise.all([deps.readCard(board, cardId), deps.readBoardConfig(board)]);
    if (!card || !config) return { action: "skipped", reason: "card ou board ilegível" };
    const key = auditKey(pending);
    let rows = await deps.ledger.load();
    const prior = rows.find((e) => e.key === key);
    if (prior?.outcome === "answered" || prior?.outcome === "declined") return { action: "skipped", reason: "esta entrega já foi auditada" };
    const entry = (what: string, why: string, extra: Partial<SystemDecision> = {}): SystemDecision => ({
      v: 1,
      id: newSystemDecisionId(),
      at: nowIso(),
      board,
      cardId,
      agent: "technical-auditor",
      kind: "technical-audit",
      what,
      why,
      ...extra,
    });
    const settle = async (outcome: "answered" | "declined", detail?: string) => {
      rows = upsert(rows, { key, attempts: (prior?.attempts ?? 0) + 1, lastAt: nowIso(), outcome, ...(detail ? { detail } : {}) });
      await deps.ledger.persist(rows);
    };
    if (!range) {
      await settle("declined", "sem intervalo de commits");
      await deps
        .record(entry(`A entrega técnica «${card.title}» caiu na amostra, mas o card não guarda a mudança`, "sem o intervalo de commits o auditor não tem o que ler — nada foi pedido a ninguém"))
        .catch(() => {});
      return { action: "gave-up", reason: "sem intervalo de commits" };
    }
    if (!deps.masterEnabled()) return { action: "waiting", reason: "autorun desligado — o auditor espera" };
    // O auditor é trabalho de FUNDO (uma amostra, não o que destrava um card): só roda com o board em ritmo normal.
    const gate = gateOf(deps.boardGate, board, config);
    if (gate.held || !gate.background) return { action: "waiting", reason: `${gate.why} — o auditor espera` };
    const refused = deps.admission();
    if (refused) return { action: "waiting", reason: `máquina/janela saturada: ${refused}` };
    if ((prior?.attempts ?? 0) >= TECHNICAL_AUDIT_MAX_ATTEMPTS) return { action: "gave-up", reason: "tentativas esgotadas" };

    const fail = async (why: string): Promise<TechnicalAuditOutcome> => {
      const attempts = (prior?.attempts ?? 0) + 1;
      const last = attempts >= TECHNICAL_AUDIT_MAX_ATTEMPTS;
      rows = upsert(rows, { key, attempts, lastAt: nowIso(), outcome: last ? "declined" : "failed", detail: why.slice(0, 200) });
      await deps.ledger.persist(rows);
      log(`${board}/${cardId}: tentativa ${attempts}/${TECHNICAL_AUDIT_MAX_ATTEMPTS} falhou — ${why}`);
      if (!last) return { action: "failed", reason: why };
      await deps.record(entry(`A auditoria técnica de «${card.title}» não rodou`, `${why} — a entrega segue no ar como estava; ninguém foi chamado`)).catch(() => {});
      return { action: "gave-up", reason: why };
    };

    const material = await deps.materialize(range);
    if ("error" in material) return fail(`a mudança não pôde ser lida: ${material.error}`);
    const res = await deps.audit({ board, cardId, card, proof: deliveryProofOf(card.body), range, material });
    if (!res.output) return fail(res.error ?? "o auditor não deu veredito");
    const out = res.output;
    if (out.verdict === "approve") {
      await settle("answered", res.runId);
      await deps.record(entry(`O auditor independente conferiu a entrega técnica «${card.title}»: sem problema`, out.summary)).catch(() => {});
      return { action: "passed" };
    }
    const fixId = await deps.openFixCard(board, cardId, out).catch(() => null);
    await settle("answered", fixId ?? res.runId);
    await deps
      .record(
        entry(
          `O auditor independente achou problema na entrega «${card.title}» e abriu um card de conserto${fixId ? ` (${fixId})` : ""}`,
          out.summary,
          fixId ? { undo: { kind: "discard-card", cardId: fixId } } : {},
        ),
      )
      .catch(() => {});
    return { action: "fix-card", fixId };
  } catch (err) {
    return { action: "failed", reason: String(err instanceof Error ? err.message : err).slice(0, 200) };
  }
}

const sameAudit = (a: TechnicalAuditPending, b: TechnicalAuditPending) => auditKey(a) === auditKey(b);

/** A entrega sorteada entra na fila durável e é tentada agora; sai da fila quando termina. Nunca lança. */
export async function startTechnicalAudit(deps: TechnicalAuditDeps, pending: TechnicalAuditPending): Promise<TechnicalAuditOutcome> {
  const list = await deps.pending.load().catch(() => [] as TechnicalAuditPending[]);
  if (!list.some((p) => sameAudit(p, pending))) await deps.pending.save([...list, pending]).catch(() => {});
  const outcome = await auditTechnicalDelivery(deps, pending);
  if (isFinalAuditOutcome(outcome)) {
    const now = await deps.pending.load().catch(() => [] as TechnicalAuditPending[]);
    await deps.pending.save(now.filter((p) => !sameAudit(p, pending))).catch(() => {});
  }
  return outcome;
}

/** A varredura (o tick da frota): retoma o que esperava ou falhou. Uma por vez — o auditor é um run caro. */
export async function sweepTechnicalAudits(deps: TechnicalAuditDeps): Promise<Array<{ board: string; cardId: string; action: TechnicalAuditOutcome["action"] }>> {
  const report: Array<{ board: string; cardId: string; action: TechnicalAuditOutcome["action"] }> = [];
  const list = await deps.pending.load().catch(() => [] as TechnicalAuditPending[]);
  let kept = list;
  for (const p of list) {
    const outcome = await auditTechnicalDelivery(deps, p);
    report.push({ board: p.board, cardId: p.cardId, action: outcome.action });
    if (isFinalAuditOutcome(outcome)) kept = kept.filter((x) => !sameAudit(x, p));
    if (outcome.action === "waiting") break;
  }
  if (kept.length !== list.length) await deps.pending.save(kept).catch(() => {});
  return report;
}
